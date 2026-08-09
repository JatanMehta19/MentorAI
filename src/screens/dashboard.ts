import type { Lesson, StudentProfile, Subject } from '../types.ts';

interface DashboardOptions {
  profile: StudentProfile | null;
  lessons: Lesson[];
  isOnline: boolean;
  onOpenLesson: (subject: Subject) => void;
}

function getLevelFromXP(xp: number): number {
  return Math.floor(xp / 200) + 1;
}

function formatDate(): string {
  const options: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'short', day: 'numeric' };
  return new Date().toLocaleDateString('en-US', options);
}

export function renderDashboard(options: DashboardOptions): HTMLElement {
  const container = document.createElement('div');
  container.className = 'app-layout';
  
  const nickname = options.profile?.nickname ?? 'Student';
  const totalXP = options.profile?.totalXP ?? 0;
  const streak = options.profile?.streak ?? 0;
  const currentLevel = getLevelFromXP(totalXP);
  const xpInLevel = totalXP % 200;
  const xpProgress = Math.max(12, (xpInLevel / 200) * 100);
  
  const mathLessons = options.lessons.filter(l => l.subject === 'math');
  const elaLessons = options.lessons.filter(l => l.subject === 'ela');
  
  const mathLastScore = 0;
  const elaLastScore = 0;

  container.innerHTML = `
    <div class="main-content">
      <div class="page-center">
        <div class="progress-header">
          <h1>Welcome back, ${nickname}</h1>
          <p>Ready to continue learning? <span class="dashboard-date">${formatDate()}</span></p>
        </div>

        <div class="progress-stats-grid">
          <div class="stat-card">
            <div class="stat-icon gold">🏆</div>
            <div class="stat-info">
              <div class="stat-label">Total XP</div>
              <div class="stat-value">${totalXP}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange">🔥</div>
            <div class="stat-info">
              <div class="stat-label">Streak</div>
              <div class="stat-value">${streak}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon accent">📚</div>
            <div class="stat-info">
              <div class="stat-label">Lessons</div>
              <div class="stat-value">${options.lessons.length}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon purple">⭐</div>
            <div class="stat-info">
              <div class="stat-label">Level</div>
              <div class="stat-value">${currentLevel}</div>
            </div>
          </div>
        </div>

        <div class="mastery-card">
          <div class="mastery-bar-container">
            <div class="mastery-label">
              <span>Level ${currentLevel} Progress</span>
              <span>${xpInLevel} / 200 XP</span>
            </div>
            <div class="mastery-bar">
              <div class="mastery-fill" style="width: ${xpProgress}%"></div>
            </div>
          </div>
        </div>

        <div class="progress-section">
          <h2>Continue Learning</h2>
          
          <div class="subject-breakdown-grid">
            <div class="subject-progress-card math">
              <div class="subject-card-header">
                <span class="subject-icon math">📐</span>
                <span class="subject-name">Math</span>
              </div>
              <div class="subject-card-stats">
                <div class="subject-xp">${mathLessons.length} lessons</div>
                <div class="subject-lessons">
                  Last Score: ${mathLastScore}%
                </div>
              </div>
              <button class="btn-continue btn-math" data-action="open-math">
                Continue Math
              </button>
            </div>

            <div class="subject-progress-card ela">
              <div class="subject-card-header">
                <span class="subject-icon ela">📖</span>
                <span class="subject-name">ELA</span>
              </div>
              <div class="subject-card-stats">
                <div class="subject-xp">${elaLessons.length} lessons</div>
                <div class="subject-lessons">
                  Last Score: ${elaLastScore}%
                </div>
              </div>
              <button class="btn-continue btn-ela" data-action="open-ela">
                Continue ELA
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  setTimeout(() => {
    const xpFill = container.querySelector('[data-xp-fill]') as HTMLElement;
    if (xpFill && xpFill.dataset.xpFill) {
      xpFill.style.width = xpFill.dataset.xpFill;
    }
  }, 100);

  const mathCard = container.querySelector('[data-action="open-math"]');
  const elaCard = container.querySelector('[data-action="open-ela"]');

  mathCard?.addEventListener('click', () => options.onOpenLesson('math'));
  elaCard?.addEventListener('click', () => options.onOpenLesson('ela'));

  return container;
}

export function showDashboard(options: DashboardOptions): HTMLElement {
  const container = renderDashboard(options);
  return container;
}