// utils/offline.test.ts
// Covers the durable sync queue: that queued work survives being offline, drains
// exactly once on reconnect, and gives up on a poisoned row instead of retrying
// it forever.
//
// The Gemini layer is mocked — these tests are about the queue's control flow,
// not the network. Dexie runs for real against fake-indexeddb (see vitest.setup.ts)
// so the retry counters are asserted against actual IndexedDB rows.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  replaceQuestion:        vi.fn(),
  generateLesson:         vi.fn(),
  generateProgressReport: vi.fn(),
  getWritingFeedback:     vi.fn(),
}));

vi.mock('../src/gemini', () => mocks);

import {
  initOfflineSync,
  flushSyncQueue,
  registerSyncCallbacks,
  resetSyncCallbacks,
  isOnline,
  withOfflineSupport,
  getConnectionStatus,
} from './offline';
import { db, addToSyncQueue, getPendingSyncItems } from '../src/db';
import type { Question } from '../src/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * jsdom defines navigator.onLine on Navigator.prototype, so vi.spyOn cannot
 * intercept it. Redefining the property on the instance is the way in.
 */
let online = true;
function setOnline(value: boolean): void {
  online = value;
}

Object.defineProperty(navigator, 'onLine', {
  configurable: true,
  get: () => online,
});

/** A valid replacement question — the shape a successful Gemini call returns. */
const QUESTION: Question = {
  prompt:       '7 x 8 = ?',
  choices:      ['54', '56', '64', '48'],
  correctIndex: 1,
  hint:         'Count by eights.',
  answered:     false,
  correct:      false,
  difficulty:   2,
};

/** Enqueue a replace_question job against a lesson that exists in the db. */
async function queueReplaceQuestion(lessonId: number): Promise<void> {
  await addToSyncQueue('replace_question', {
    lessonId,
    questionIndex: 0,
    subject:       'math',
    grade:         7,
    topic:         'multiplication',
    difficulty:    1,
  });
}

/** Seed a lesson so replaceQuestionInLesson has a real row to write into. */
async function seedLesson(): Promise<number> {
  return (await db.lessons.add({
    subject:     'math',
    grade:       7,
    language:    'en',
    title:       'Multiplication',
    content:     'Lesson body.',
    questions:   [QUESTION],
    createdAt:   new Date().toISOString(),
    isPreloaded: true,
  })) as number;
}

/**
 * Wait for an in-flight drain to finish.
 *
 * A drain started by a timer outlives the await that triggered it, and the
 * engine's in-progress flag is module state — leaving one running would make the
 * *next* test's flushSyncQueue() return at the re-entry guard and assert nothing.
 * getConnectionStatus() already reports 'syncing' while a drain is live, so that
 * is the signal to poll.
 */
async function settleDrain(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (getConnectionStatus() !== 'syncing') return;
    await vi.advanceTimersByTimeAsync(2000);   // covers a pending RETRY_DELAY_MS
  }
}

/** Fire a window event and let the debounce timer and its async drain settle. */
async function reconnect(): Promise<void> {
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(1500);   // SYNC_DEBOUNCE
  await settleDrain();
}

// ── Setup ─────────────────────────────────────────────────────────────────────

// Once for the whole file. initOfflineSync adds window/document listeners with no
// way to remove them, so calling it per test would stack duplicate handlers.
beforeAll(() => {
  initOfflineSync();
});

beforeEach(async () => {
  vi.clearAllMocks();
  resetSyncCallbacks();
  setOnline(true);
  mocks.replaceQuestion.mockResolvedValue(QUESTION);
  await db.syncQueue.clear();
  await db.lessons.clear();

  // Fake ONLY what the sync engine schedules on. fake-indexeddb drives its
  // transactions off setImmediate, so faking that would deadlock every Dexie
  // call in here — including this file's own setup.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  await settleDrain();
  vi.useRealTimers();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('connection helpers', () => {
  it('reports the live connection state', () => {
    setOnline(false);
    expect(isOnline()).toBe(false);
    expect(getConnectionStatus()).toBe('offline');

    setOnline(true);
    expect(isOnline()).toBe(true);
    expect(getConnectionStatus()).toBe('online');
  });
});

describe('queue offline, drain on reconnect', () => {
  it('holds work while offline and flushes it once the connection returns', async () => {
    const lessonId = await seedLesson();
    setOnline(false);

    await queueReplaceQuestion(lessonId);
    await flushSyncQueue();

    // Nothing should have gone out over a dead connection.
    expect(mocks.replaceQuestion).not.toHaveBeenCalled();
    expect(await getPendingSyncItems()).toHaveLength(1);

    setOnline(true);
    await reconnect();

    expect(mocks.replaceQuestion).toHaveBeenCalledTimes(1);
    expect(await getPendingSyncItems()).toHaveLength(0);
  });

  it('writes the generated question back into the lesson', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);

    await flushSyncQueue();

    const lesson = await db.lessons.get(lessonId);
    expect(lesson?.questions[0].prompt).toBe(QUESTION.prompt);
  });

  it('debounces a flapping connection into a single drain', async () => {
    const lessonId = await seedLesson();
    setOnline(false);
    await queueReplaceQuestion(lessonId);

    setOnline(true);

    // Three reconnects inside the debounce window.
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(400);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(400);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1500);

    expect(mocks.replaceQuestion).toHaveBeenCalledTimes(1);
  });

  it('drains when the tab is foregrounded', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);

    document.dispatchEvent(new Event('visibilitychange'));
    await settleDrain();

    expect(mocks.replaceQuestion).toHaveBeenCalledTimes(1);
  });
});

describe('failure handling', () => {
  it('increments retries and leaves the item queued when a job fails', async () => {
    const lessonId = await seedLesson();
    mocks.replaceQuestion.mockRejectedValue(new Error('Gemini 503'));
    await queueReplaceQuestion(lessonId);

    // The RETRY_DELAY_MS timer isn't scheduled until the drain has awaited
    // several Dexie reads, so advancing the clock once would step over it.
    const drain = flushSyncQueue();
    await settleDrain();
    await drain;

    const pending = await getPendingSyncItems();
    expect(pending).toHaveLength(1);
    expect(pending[0].retries).toBe(1);
  });

  it('drops an item once it has burned through MAX_RETRIES', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);

    // Simulate three prior failed attempts.
    const [item] = await getPendingSyncItems();
    await db.syncQueue.update(item.id as number, { retries: 3 });

    await flushSyncQueue();

    // Cleared without another call — one poisoned row must not block the queue.
    expect(mocks.replaceQuestion).not.toHaveBeenCalled();
    expect(await getPendingSyncItems()).toHaveLength(0);
  });

  it('clears an unrecognised job type instead of retrying it forever', async () => {
    await db.syncQueue.add({
      // Deliberately not a SyncType — models a row written by an older build.
      type:      'legacy_job' as never,
      payload:   {},
      timestamp: Date.now(),
      retries:   0,
    });

    await flushSyncQueue();

    expect(await getPendingSyncItems()).toHaveLength(0);
  });

  it('stops mid-drain when the connection drops and keeps the rest queued', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);
    await queueReplaceQuestion(lessonId);
    await queueReplaceQuestion(lessonId);

    // The first job succeeds, then the device goes offline.
    mocks.replaceQuestion.mockImplementationOnce(async () => {
      setOnline(false);
      return QUESTION;
    });

    await flushSyncQueue();

    expect(mocks.replaceQuestion).toHaveBeenCalledTimes(1);
    expect(await getPendingSyncItems()).toHaveLength(2);
  });
});

describe('concurrency', () => {
  it('processes each item once when two drains overlap', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);
    await queueReplaceQuestion(lessonId);

    await Promise.all([flushSyncQueue(), flushSyncQueue()]);

    expect(mocks.replaceQuestion).toHaveBeenCalledTimes(2);
    expect(await getPendingSyncItems()).toHaveLength(0);
  });
});

describe('callbacks', () => {
  it('reports start and completion with the processed count', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);
    await queueReplaceQuestion(lessonId);

    const onSyncStart    = vi.fn();
    const onSyncComplete = vi.fn();
    registerSyncCallbacks({ onSyncStart, onSyncComplete });

    await flushSyncQueue();

    expect(onSyncStart).toHaveBeenCalledTimes(1);
    expect(onSyncComplete).toHaveBeenCalledWith(2);
    expect(onSyncStart.mock.invocationCallOrder[0])
      .toBeLessThan(onSyncComplete.mock.invocationCallOrder[0]);
  });

  it('stays quiet when there is nothing queued', async () => {
    const onSyncStart = vi.fn();
    registerSyncCallbacks({ onSyncStart });

    await flushSyncQueue();

    expect(onSyncStart).not.toHaveBeenCalled();
  });

  it('reports connection changes', async () => {
    const onStatusChange = vi.fn();
    registerSyncCallbacks({ onStatusChange });

    window.dispatchEvent(new Event('offline'));
    expect(onStatusChange).toHaveBeenLastCalledWith(false);

    window.dispatchEvent(new Event('online'));
    expect(onStatusChange).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(1500);
  });

  it('finishes the drain even when a listener throws', async () => {
    const lessonId = await seedLesson();
    await queueReplaceQuestion(lessonId);

    registerSyncCallbacks({
      onSyncStart: () => { throw new Error('UI blew up'); },
    });

    await expect(flushSyncQueue()).resolves.toBeUndefined();

    // The queue drained despite the broken listener, and the engine is not stuck.
    expect(await getPendingSyncItems()).toHaveLength(0);
    expect(getConnectionStatus()).toBe('online');
  });
});

describe('withOfflineSupport', () => {

  it('runs the action and skips the fallback when online', async () => {
    setOnline(true);
    const action   = vi.fn().mockResolvedValue('done');
    const fallback = vi.fn().mockResolvedValue(undefined);

    await expect(withOfflineSupport(action, fallback)).resolves.toBe('done');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('skips the action and queues when offline', async () => {
    setOnline(false);
    const action   = vi.fn();
    const fallback = vi.fn().mockResolvedValue(undefined);

    await expect(withOfflineSupport(action, fallback)).resolves.toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('queues when the online attempt fails', async () => {
    setOnline(true);
    const action   = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const fallback = vi.fn().mockResolvedValue(undefined);

    await expect(withOfflineSupport(action, fallback)).resolves.toBeNull();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('rethrows instead of queueing when shouldQueue says no', async () => {
    // A request the server already refused fails identically on every retry.
    // Queueing it spends the whole retry budget and tells the student they are
    // offline while they are plainly not.
    setOnline(true);
    const refused  = new Error('Too many requests.');
    const action   = vi.fn().mockRejectedValue(refused);
    const fallback = vi.fn().mockResolvedValue(undefined);

    await expect(withOfflineSupport(action, fallback, () => false)).rejects.toBe(refused);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('still queues offline even when shouldQueue would veto', async () => {
    // The veto is about how a *reply* was refused. With no connection there was
    // no reply, so the queue is the only correct answer.
    setOnline(false);
    const action   = vi.fn();
    const fallback = vi.fn().mockResolvedValue(undefined);

    await expect(withOfflineSupport(action, fallback, () => false)).resolves.toBeNull();
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('passes the thrown error to the predicate', async () => {
    setOnline(true);
    const boom       = new Error('boom');
    const shouldQueue = vi.fn().mockReturnValue(true);

    await withOfflineSupport(
      vi.fn().mockRejectedValue(boom),
      vi.fn().mockResolvedValue(undefined),
      shouldQueue,
    );

    expect(shouldQueue).toHaveBeenCalledWith(boom);
  });
});
