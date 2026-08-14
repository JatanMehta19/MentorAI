// src/screens/dashboard.ts
//
// The home screen. Everything shown here is derived from data that actually
// survives a reload — Progress rows and the per-question flags on each Lesson.
// Nothing reads profile.totalXP, which is mutated in memory but never written back.

import type { Lesson, Progress, StudentProfile, Subject } from '../types.ts';

export interface DashboardOptions {
  profile: StudentProfile | null;
  lessons: Lesson[];
  progress: Progress[];
  isOnline: boolean;
  /** Items sitting in the sync queue, from getPendingSyncItems(). */
  pendingSyncCount: number;
  onSelectLesson: (lessonId: number) => void;
}

type LessonState = 'done' | 'in progress' | 'up next';
type Filter = 'all' | Subject;

/** Boss battles write a Progress row under this sentinel — never a real lesson. */
const BOSS_LESSON_ID = 99999;

const SUBJECT_LABEL: Record<Subject, string> = { math: 'Math', ela: 'ELA' };

// Survives re-renders so the chosen filter sticks while the student navigates.
let activeFilter: Filter = 'all';


// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function answeredCount(lesson: Lesson): number {
  return lesson.questions.filter((q) => q.answered).length;
}


// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Build the home screen: resume hero, sync notice, lesson rail, stat cards.
 * Returns a detached element with its listeners already attached.
 */
export function renderDashboard(options: DashboardOptions): HTMLElement {
  const { profile, lessons, progress, isOnline, pendingSyncCount, onSelectLesson } = options;

  // Lessons the student has finished at least once. The boss sentinel would
  // otherwise inflate every count on this page.
  const completed = new Set(
    progress.filter((p) => p.lessonId !== BOSS_LESSON_ID).map((p) => p.lessonId)
  );

  function stateOf(lesson: Lesson): LessonState {
    if (lesson.id !== undefined && completed.has(lesson.id)) return 'done';
    const answered = answeredCount(lesson);
    return answered > 0 && answered < lesson.questions.length ? 'in progress' : 'up next';
  }

  // Resume target: whatever is half-finished, else the next untouched lesson.
  const resumeLesson =
    lessons.find((l) => stateOf(l) === 'in progress') ??
    lessons.find((l) => stateOf(l) === 'up next') ??
    null;

  const nickname = profile?.nickname ?? 'Student';
  const streak = profile?.streak ?? 0;

  const realProgress = progress.filter((p) => p.lessonId !== BOSS_LESSON_ID);
  const avgScore = realProgress.length
    ? Math.round(realProgress.reduce((sum, p) => sum + p.score, 0) / realProgress.length)
    : 0;
  const totalXP = progress.reduce((sum, p) => sum + p.xpEarned, 0);

  const container = document.createElement('div');
  container.className = 'main-content';
  container.innerHTML = `
    <div class="page-center home">
      ${renderHero()}
      ${renderSyncBanner()}

      <div class="home-section-head">
        <h2 class="home-section-title">Today's path</h2>
        <div class="home-filters">
          ${(['all', 'math', 'ela'] as Filter[])
            .map(
              (f) => `
            <button type="button" class="filter-pill${f === activeFilter ? ' selected' : ''}"
                    data-filter="${f}">${f === 'all' ? 'All' : SUBJECT_LABEL[f]}</button>`
            )
            .join('')}
        </div>
      </div>

      <div class="lesson-rail">${renderRail()}</div>

      <div class="home-stats">
        ${statCard(String(completed.size), 'Lessons complete')}
        ${statCard(`${avgScore}%`, 'Average score')}
        ${statCard(String(totalXP), 'XP earned')}
      </div>
    </div>
  `;

  function renderHero(): string {
    if (!lessons.length) return '';

    if (!resumeLesson) {
      return `
      <div class="home-hero">
        <div class="hero-main">
          <div class="hero-eyebrow">ALL CAUGHT UP</div>
          <h1 class="hero-title">Nice work, ${escapeHtml(nickname)}</h1>
          <p class="hero-sub">You've finished every lesson for grade ${profile?.grade ?? ''}.</p>
        </div>
        <div class="hero-side">
          ${streakBlock()}
          <button type="button" class="hero-cta" data-lesson-id="${lessons[0].id ?? ''}">
            Practice again
          </button>
        </div>
      </div>`;
    }

    const answered = answeredCount(resumeLesson);
    const total = resumeLesson.questions.length;
    const pct = total ? (answered / total) * 100 : 0;

    return `
      <div class="home-hero">
        <div class="hero-main">
          <div class="hero-eyebrow">PICK UP WHERE YOU LEFT OFF</div>
          <h1 class="hero-title">${escapeHtml(resumeLesson.title)}</h1>
          <div class="hero-progress">
            <div class="hero-bar"><div class="hero-bar-fill" style="width: ${pct}%"></div></div>
            <div class="hero-count">${answered} of ${total}</div>
          </div>
        </div>
        <div class="hero-side">
          ${streakBlock()}
          <button type="button" class="hero-cta" data-lesson-id="${resumeLesson.id ?? ''}">
            Resume
          </button>
        </div>
      </div>`;
  }

  function streakBlock(): string {
    return `
      <div class="hero-streak">
        <div class="hero-streak-value">${streak}</div>
        <div class="hero-streak-label">day streak</div>
      </div>`;
  }

  // Only shown when it is telling the truth about the sync engine's actual state.
  function renderSyncBanner(): string {
    if (isOnline && pendingSyncCount === 0) return '';
    const message = !isOnline
      ? 'Working offline. Lessons are cached on this device and your progress saves locally — it syncs the moment you reconnect.'
      : `${pendingSyncCount} ${pendingSyncCount === 1 ? 'item is' : 'items are'} waiting to sync.`;
    return `<div class="sync-banner">${message}</div>`;
  }

  function renderRail(): string {
    const visible = lessons.filter(
      (l) => activeFilter === 'all' || l.subject === activeFilter
    );

    if (!visible.length) {
      return `<p class="rail-empty">No lessons here yet.</p>`;
    }

    return visible
      .map((lesson, i) => {
        const state = stateOf(lesson);
        const slug = state.replace(' ', '-');
        return `
        <button type="button" class="rail-row" data-state="${slug}" data-lesson-id="${lesson.id ?? ''}">
          <span class="rail-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="rail-body">
            <span class="rail-title">${escapeHtml(lesson.title)}</span>
            <span class="rail-meta">${SUBJECT_LABEL[lesson.subject]} · ${lesson.questions.length} questions</span>
          </span>
          <span class="rail-state">${state}</span>
        </button>`;
      })
      .join('');
  }

  function statCard(value: string, label: string): string {
    return `
      <div class="home-stat">
        <div class="home-stat-value">${value}</div>
        <div class="home-stat-label">${label}</div>
      </div>`;
  }

  // ── Listeners ──────────────────────────────────────────────────────────────
  // Deliberately no data-action/data-page/data-route on anything above: the
  // global delegator in main.ts intercepts all three and reroutes the click.

  const rail = container.querySelector('.lesson-rail') as HTMLElement;

  function openLesson(el: Element | null): void {
    const id = Number((el as HTMLElement | null)?.dataset.lessonId);
    if (Number.isFinite(id) && id > 0) onSelectLesson(id);
  }

  rail.addEventListener('click', (e) => {
    openLesson((e.target as HTMLElement).closest('.rail-row'));
  });

  container.querySelector('.hero-cta')?.addEventListener('click', (e) => {
    openLesson(e.currentTarget as HTMLElement);
  });

  // Repaint only the rail — a full render() would re-parse every screen, which is
  // the per-navigation stutter we are trying to avoid on low-end hardware.
  container.querySelectorAll<HTMLButtonElement>('.filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      activeFilter = pill.dataset.filter as Filter;
      container.querySelectorAll('.filter-pill').forEach((p) => {
        p.classList.toggle('selected', p === pill);
      });
      rail.innerHTML = renderRail();
    });
  });

  return container;
}
