import type { Lesson, StudentProfile, Subject } from '../types';
import { escapeHtml } from '../utils/escape';

/** Where the "generate a lesson" card is in its lifecycle. */
export type GenerateState = 'idle' | 'working' | 'queued' | 'exhausted' | 'busy';

interface SubjectPageOptions {
  subject: Subject;
  lessons: Lesson[];
  profile: StudentProfile | null;
  isOnline: boolean;
  generateState: GenerateState;
  onSelectLesson: (lessonId: number) => void;
  onStartBoss: (subject: Subject) => void;
  onGenerateLesson: () => void;
  onGoBack: () => void;
}

function getLevelFromXP(xp: number): number {
  return Math.floor(xp / 200) + 1;
}

/**
 * Copy for the generate card.
 *
 * The offline wording matters: pressing the button with no connection is a
 * supported path, not a failure. The request becomes a durable sync-queue row
 * and drains on reconnect, so the student should be told that plainly rather
 * than shown a disabled button.
 */
function generateCopy(options: SubjectPageOptions): string {
  switch (options.generateState) {
    case 'working':
      return 'Writing a new lesson…';
    case 'queued':
      return 'Queued. This will be written the next time you are online — you can keep working.';
    case 'exhausted':
      return 'You have generated every extra topic available for this grade.';
    case 'busy':
      return 'The AI tutor has hit its limit for the moment. Give it a minute and try again.';
    default:
      return options.isOnline
        ? 'Ask the AI tutor to write you a new lesson on a topic you have not covered yet.'
        : 'You are offline. Ask anyway — the lesson will be queued and written when you reconnect.';
  }
}

function generateLabel(options: SubjectPageOptions): string {
  switch (options.generateState) {
    case 'working':   return '✨ Generating…';
    case 'queued':    return '✨ Queue another';
    case 'exhausted': return 'All topics generated';
    case 'busy':      return '✨ Try again shortly';
    default:          return options.isOnline ? '✨ Generate a new lesson' : '✨ Queue a new lesson';
  }
}

export function renderSubjectPage(options: SubjectPageOptions): HTMLElement {
  const container = document.createElement('div');
  
  const currentLevel = options.profile ? getLevelFromXP(options.profile.totalXP) : 1;
  const subjectTitle = options.subject === 'math' ? 'Math' : 'ELA';
  const subjectIcon = options.subject === 'math' ? '📐' : '📖';
  const isMath = options.subject === 'math';
  
  container.innerHTML = `
    <div class="main-content">
      <div class="page-center">
        <div class="progress-header">
          <button class="btn-back" data-action="back">&larr; Back</button>
          <h1>
            <span class="subject-icon ${isMath ? 'math' : 'ela'}">${subjectIcon}</span>
            ${subjectTitle}
          </h1>
          <p>Choose a lesson to begin learning</p>
        </div>

        <div class="progress-stats-grid">
          <div class="stat-card">
            <div class="stat-icon ${isMath ? 'purple' : 'teal'}">${subjectIcon}</div>
            <div class="stat-info">
              <div class="stat-label">Available Lessons</div>
              <div class="stat-value">${options.lessons.length}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-info">
              <div class="stat-label">Your Level</div>
              <div class="stat-value">${currentLevel}</div>
            </div>
          </div>
        </div>

        <div class="progress-section">
          <h2>${subjectTitle} Lessons</h2>
          
          <div class="lesson-grid">
            ${options.lessons.length > 0 ? options.lessons.map(lesson => `
              <div class="lesson-card" data-lesson-id="${lesson.id}">
                <div class="lesson-card-title">${escapeHtml(lesson.title)}</div>
                <div class="lesson-card-meta">Grade ${lesson.grade} • ${lesson.language.toUpperCase()}</div>
                <div class="lesson-card-questions">${lesson.questions.length} questions</div>
                <button class="btn-start-lesson ${isMath ? '' : 'ela'}" data-action="start-lesson-${lesson.id}">Start Lesson</button>
              </div>
            `).join('') : `
              <div class="empty-state">
                <p>No ${subjectTitle.toLowerCase()} lessons available yet.</p>
                <p>Check back soon!</p>
              </div>
            `}
          </div>
        </div>

        <div class="progress-section">
          <h2>More ${subjectTitle}</h2>
          <div class="mastery-card">
            <p>${generateCopy(options)}</p>
            <button
              class="btn-boss ${isMath ? '' : 'ela'}"
              data-generate="1"
              ${options.generateState === 'working' || options.generateState === 'exhausted' ? 'disabled' : ''}
            >${generateLabel(options)}</button>
          </div>
        </div>

        <div class="progress-section">
          <h2>${subjectTitle} Boss Battle</h2>
          <div class="mastery-card">
            <p>Test your skills against the ${subjectTitle} boss!</p>
            <button class="btn-boss ${isMath ? '' : 'ela'}" data-action="boss-${options.subject}">
              🔥 Start ${subjectTitle} Boss
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  // Wire up Back button
  const backBtn = container.querySelector('[data-action="back"]');
  backBtn?.addEventListener('click', () => options.onGoBack());

  // Wire up Start Lesson buttons
  options.lessons.forEach(lesson => {
    const btn = container.querySelector(`[data-action="start-lesson-${lesson.id}"]`);
    btn?.addEventListener('click', () => options.onSelectLesson(lesson.id as number));
  });

  // Wire up Boss button
  const bossBtn = container.querySelector(`[data-action="boss-${options.subject}"]`);
  bossBtn?.addEventListener('click', () => options.onStartBoss(options.subject));

  // data-generate, not data-action: the global delegator in main.ts treats every
  // data-action as a route and would fire a second render mid-generation.
  const generateBtn = container.querySelector('[data-generate]');
  generateBtn?.addEventListener('click', () => options.onGenerateLesson());

  return container;
}

export function renderProgressPlaceholder(): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="main-content">
      <div class="placeholder-screen">
        <div class="placeholder-icon">📊</div>
        <h1>Progress</h1>
        <p>Track your learning journey coming soon.</p>
      </div>
    </div>
  `;
  return container;
}

export function renderSettingsPlaceholder(): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = `
    <div class="main-content">
      <div class="page-center">
        <div class="progress-header">
          <h1>Settings</h1>
          <p>Customize your experience</p>
        </div>
        <div class="mastery-card">
          <div class="placeholder-icon">⚙️</div>
          <h2>Settings Coming Soon</h2>
          <p>Customize your preferences and profile coming soon.</p>
        </div>
      </div>
    </div>
  `;
  return container;
}