// utils/offline.ts
import {
  getPendingSyncItems,
  clearSyncItem,
  incrementSyncRetry,
  saveLesson,
  replaceQuestionInLesson,
  updateProfile,
} from '../src/db';
import {
  generateLesson,
  replaceQuestion,
  generateProgressReport,
  getWritingFeedback,
} from '../src/gemini';
import type { SyncQueueItem, Subject, Grade } from '../src/types';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2000;
const SYNC_DEBOUNCE  = 1500;

// ── Sync State ────────────────────────────────────────────────────────────────

let syncInProgress    = false;
let syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── UI Callbacks ──────────────────────────────────────────────────────────────

export interface SyncCallbacks {
  onSyncStart:    () => void;
  onSyncComplete: (count: number) => void;
  onSyncError:    (msg: string) => void;
  onStatusChange: (online: boolean) => void;
}

const noop = (): void => {};

// Held in one object rather than four `export let` bindings. Live-binding
// exports could be read but never reliably reset, which made the module
// impossible to test twice in the same process.
const callbacks: SyncCallbacks = {
  onSyncStart:    noop,
  onSyncComplete: noop,
  onSyncError:    noop,
  onStatusChange: noop,
};

/**
 * Call this once in main.ts to connect the sync engine to your UI.
 * Each callback is optional — only pass the ones you need.
 */
export function registerSyncCallbacks(partial: Partial<SyncCallbacks>): void {
  Object.assign(callbacks, partial);
}

/** Restore the no-op defaults. Used by tests so cases can't leak into each other. */
export function resetSyncCallbacks(): void {
  callbacks.onSyncStart    = noop;
  callbacks.onSyncComplete = noop;
  callbacks.onSyncError    = noop;
  callbacks.onStatusChange = noop;
}

/**
 * Invoke a UI callback without letting it break the drain.
 * A listener that throws is a UI bug; it must not strand queued items or leave
 * syncInProgress stuck, which is exactly what an unguarded call would do.
 */
function emit<K extends keyof SyncCallbacks>(
  name: K,
  ...args: Parameters<SyncCallbacks[K]>
): void {
  try {
    // TS can't prove callbacks[name] accepts args when K is still generic,
    // so the correlation is asserted here rather than at every call site.
    (callbacks[name] as (...a: Parameters<SyncCallbacks[K]>) => void)(...args);
  } catch (err) {
    console.error(`[Sync] Listener "${name}" threw:`, err);
  }
}

// ── Connection Helpers ────────────────────────────────────────────────────────

export function isOnline(): boolean {
  return navigator.onLine;
}

export function getConnectionStatus(): 'online' | 'offline' | 'syncing' {
  if (syncInProgress) return 'syncing';
  return isOnline() ? 'online' : 'offline';
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Call this ONCE in main.ts on app startup.
 * Registers online/offline listeners and attempts an immediate sync if online.
 */
export function initOfflineSync(): void {
  window.addEventListener('online', () => {
    emit('onStatusChange', true);
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => flushSyncQueue(), SYNC_DEBOUNCE);
  });

  window.addEventListener('offline', () => {
    emit('onStatusChange', false);
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isOnline()) {
      flushSyncQueue();
    }
  });

  if (isOnline()) flushSyncQueue();
}

// ── Sync Queue Processor ──────────────────────────────────────────────────────

export async function flushSyncQueue(): Promise<void> {
  if (syncInProgress || !isOnline()) return;
  syncInProgress = true;

  let processedCount = 0;

  try {
    const queue = await getPendingSyncItems();
    if (queue.length === 0) { syncInProgress = false; return; }

    emit('onSyncStart');
    console.log(`[Sync] Processing ${queue.length} queued items...`);

    for (const item of queue) {
      if (!isOnline()) {
        console.log('[Sync] Lost connection mid-sync — pausing.');
        break;
      }

      const itemId = item.id;
      if (typeof itemId !== 'number') {
        console.warn('[Sync] Queue item missing numeric id — skipping.');
        continue;
      }

      if ((item.retries ?? 0) >= MAX_RETRIES) {
        console.warn(`[Sync] Item ${itemId} hit max retries — clearing.`);
        await clearSyncItem(itemId);
        continue;
      }

      const success = await processSyncItem(item);

      if (success) {
        await clearSyncItem(itemId);
        processedCount++;
        console.log(`[Sync] ✓ ${item.type} (id: ${itemId})`);
      } else {
        await incrementSyncRetry(itemId);
        console.warn(`[Sync] ✗ ${item.type} failed — retry ${(item.retries ?? 0) + 1}`);
        await delay(RETRY_DELAY_MS);
      }
    }

    emit('onSyncComplete', processedCount);
    console.log(`[Sync] Done — ${processedCount} items synced.`);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown sync error';
    emit('onSyncError', message);
    console.error('[Sync] Fatal error:', err);
  } finally {
    syncInProgress = false;
  }
}

// ── Item Router ───────────────────────────────────────────────────────────────

async function processSyncItem(item: SyncQueueItem): Promise<boolean> {
  try {
    switch (item.type) {

      case 'replace_question': {
        const { lessonId, questionIndex, subject, grade, topic, difficulty } = item.payload as {
          lessonId:      number;
          questionIndex: number;
          subject:      Subject;
          grade:        Grade;
          topic:       string;
          difficulty:   1 | 2 | 3;
        };
        const newQuestion = await replaceQuestion(subject, grade, topic, difficulty);
        await replaceQuestionInLesson(lessonId, questionIndex, newQuestion);
        return true;
      }

      case 'generate_lesson': {
        const { subject, grade, topic } = item.payload as {
          subject: Subject;
          grade:   Grade;
          topic:   string;
        };
        const lesson = await generateLesson(subject, grade, topic, 'en');
        await saveLesson(lesson);
        return true;
      }

      case 'progress_report': {
        const { nickname, scores } = item.payload as {
          nickname: string;
          scores:   { lessonTitle: string; score: number; subject: Subject }[];
        };
        const report = await generateProgressReport(nickname, scores);
        // No more `as any` — lastProgressReport is now on the type
        await updateProfile(nickname, { lastProgressReport: report });
        return true;
      }

      case 'get_feedback': {
        const { question, studentAnswer, grade } = item.payload as {
          question:      string;
          studentAnswer: string;
          grade:         Grade;
        };
        const feedback = await getWritingFeedback(question, studentAnswer, grade);
        window.dispatchEvent(new CustomEvent('mentor:feedback', {
          detail: { feedback, question }
        }));
        return true;
      }

      default:
        console.warn(`[Sync] Unknown type: ${item.type} — clearing.`);
        return true;
    }
  } catch (err) {
    console.error(`[Sync] Error on item ${item.id}:`, err);
    return false;
  }
}

// ── Public Helper ─────────────────────────────────────────────────────────────

/**
 * Wraps any action with offline-aware logic.
 * If online: runs the action immediately.
 * If offline: runs the fallback (addToSyncQueue) instead.
 *
 * Usage:
 *   await withOfflineSupport(
 *     () => generateProgressReport(nickname, scores),
 *     () => addToSyncQueue('progress_report', { nickname, scores })
 *   );
 */
export async function withOfflineSupport<T>(
  onlineAction:    () => Promise<T>,
  offlineFallback: () => Promise<void>
): Promise<T | null> {
  if (isOnline()) {
    try {
      return await onlineAction();
    } catch {
      await offlineFallback();
      return null;
    }
  } else {
    await offlineFallback();
    return null;
  }
}

// ── Private Util ──────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}