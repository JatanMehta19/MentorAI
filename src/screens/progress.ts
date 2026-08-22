import type { StudentProfile, Lesson, Progress, Subject } from '../types';
import { escapeHtml } from '../utils/escape';

interface ProgressPageOptions {
  profile: StudentProfile | null;
  lessons: Lesson[];
  recentProgress: Progress[];
  isOnline: boolean;
  onNavigate: (subject: Subject) => void;
}

function getLevelFromXP(xp: number): number {
  return Math.floor(xp / 200) + 1;
}

function calcSubjectStats(lessons: Lesson[], subject: Subject, progress: Progress[]): {
  xp: number;
  lessonsCompleted: number;
  totalLessons: number;
  questionsAnswered: number;
  correctAnswers: number;
  progressPercent: number;
} {
  const subjectLessons = lessons.filter(l => l.subject === subject);
  const progressForSubject = progress.filter(p => p.subject === subject);

  const mathXP = subject === 'math' 
    ? progressForSubject.reduce((sum, p) => sum + p.xpEarned, 0) 
    : 0;
  const elaXP = subject === 'ela' 
    ? progressForSubject.reduce((sum, p) => sum + p.xpEarned, 0) 
    : 0;

  const uniqueCompletedLessons = new Set(progressForSubject.map(p => p.lessonId)).size;

  const questionsAnswered = progressForSubject.reduce((sum, p) => sum + p.attempts, 0);
  const correctAnswers = progressForSubject.filter(p => p.score >= 70).length;

  const totalQuestions = subjectLessons.reduce((sum, l) => sum + l.questions.length, 0);
  const progressPercent = totalQuestions > 0 
    ? Math.round((correctAnswers / totalQuestions) * 100) 
    : 0;

  return {
    xp: subject === 'math' ? mathXP : elaXP,
    lessonsCompleted: uniqueCompletedLessons,
    totalLessons: subjectLessons.length,
    questionsAnswered,
    correctAnswers,
    progressPercent: Math.min(progressPercent, 100)
  };
}

export function renderProgressPage(options: ProgressPageOptions): HTMLElement {
  const container = document.createElement('div');

  const profile = options.profile;
  const lessons = options.lessons;
  const progress = options.recentProgress;

  const totalXP = profile?.totalXP ?? 0;
  const currentLevel = getLevelFromXP(totalXP);
  const streak = profile?.streak ?? 0;
  const mathXP = profile?.mathXP ?? 0;
  const elaXP = profile?.elaXP ?? 0;

  const allLessons = lessons;
  const completedLessons = new Set(progress.map(p => p.lessonId)).size;
  const totalQuestions = allLessons.reduce((sum, l) => sum + l.questions.length, 0);
  const totalAnswered = progress.reduce((sum, p) => sum + p.attempts, 0);
  const totalCorrect = progress.filter(p => p.score >= 70).length;
  const avgScore = progress.length > 0 
    ? Math.round(progress.reduce((sum, p) => sum + p.score, 0) / progress.length) 
    : 0;

  const mathStats = calcSubjectStats(lessons, 'math', progress);
  const elaStats = calcSubjectStats(lessons, 'ela', progress);

  const overallProgress = totalQuestions > 0 
    ? Math.round((totalCorrect / totalQuestions) * 100) 
    : 0;

  const achievements = [
    { 
      id: 'first-quiz', 
      label: 'First Quiz', 
      icon: '🎯', 
      unlocked: totalAnswered > 0,
      desc: 'Complete your first quiz'
    },
    { 
      id: 'lesson-master', 
      label: 'Lesson Master', 
      icon: '🏆', 
      unlocked: progress.some(p => p.score === 100),
      desc: 'Get 100% on a lesson'
    },
    { 
      id: 'boss-challenger', 
      label: 'Boss Challenger', 
      icon: '👹', 
      unlocked: progress.some(p => p.score >= 50),
      desc: 'Complete a boss challenge'
    },
    { 
      id: 'streak-starter', 
      label: 'Streak Starter', 
      icon: '🔥', 
      unlocked: streak >= 3,
      desc: 'Maintain a 3-day streak'
    },
    { 
      id: 'xp-collector', 
      label: 'XP Collector', 
      icon: '💎', 
      unlocked: totalXP >= 100,
      desc: 'Earn 100 total XP'
    }
  ];

  const recentActivity = progress.length > 0 
    ? progress.slice(-5).reverse().map(p => `
      <div class="activity-item">
        <div class="activity-subject ${p.subject}">${p.subject === 'math' ? '📐' : '📖'}</div>
        <div class="activity-details">
          <div class="activity-title">${escapeHtml(p.lessonTitle)}</div>
          <div class="activity-meta">Score: ${p.score}% • +${p.xpEarned} XP</div>
        </div>
        <div class="activity-date">${new Date(p.completedAt).toLocaleDateString()}</div>
      </div>
    `).join('')
    : '';

  container.innerHTML = `
    <div class="main-content">
      <div class="page-center">
        <div class="progress-header">
          <h1>Progress</h1>
          <p>Track your learning journey and mastery.</p>
        </div>

        <div class="progress-stats-grid">
          <div class="stat-card">
            <div class="stat-icon purple">💎</div>
            <div class="stat-info">
              <div class="stat-label">Total XP</div>
              <div class="stat-value">${totalXP}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon gold">⭐</div>
            <div class="stat-info">
              <div class="stat-label">Current Level</div>
              <div class="stat-value">${currentLevel}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon orange">🔥</div>
            <div class="stat-info">
              <div class="stat-label">Current Streak</div>
              <div class="stat-value">${streak} days</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon teal">📚</div>
            <div class="stat-info">
              <div class="stat-label">Lessons Completed</div>
              <div class="stat-value">${completedLessons}</div>
            </div>
          </div>
        </div>

        <div class="progress-section">
          <h2>Mastery Overview</h2>
          <div class="mastery-card">
            <div class="mastery-bar-container">
              <div class="mastery-label">
                <span>Overall Progress</span>
                <span>${overallProgress}%</span>
              </div>
              <div class="mastery-bar">
                <div class="mastery-fill" style="width: ${overallProgress}%"></div>
              </div>
            </div>
            <div class="mastery-stats">
              <div class="mastery-stat">
                <span class="mastery-stat-value">${totalAnswered}</span>
                <span class="mastery-stat-label">Questions Answered</span>
              </div>
              <div class="mastery-stat">
                <span class="mastery-stat-value">${totalCorrect}</span>
                <span class="mastery-stat-label">Correct</span>
              </div>
              <div class="mastery-stat">
                <span class="mastery-stat-value">${avgScore}%</span>
                <span class="mastery-stat-label">Average Score</span>
              </div>
            </div>
          </div>
        </div>

        <div class="progress-section">
          <h2>Subject Breakdown</h2>
          <div class="subject-breakdown-grid">
            <div class="subject-progress-card math">
              <div class="subject-card-header">
                <span class="subject-icon math">📐</span>
                <span class="subject-name">Math</span>
              </div>
              <div class="subject-card-stats">
                <div class="subject-xp">${mathXP} XP</div>
                <div class="subject-lessons">
                  ${mathStats.lessonsCompleted} / ${mathStats.totalLessons} lessons
                </div>
                <div class="subject-questions">
                  ${mathStats.correctAnswers} / ${mathStats.questionsAnswered} correct
                </div>
              </div>
              <div class="subject-progress-bar">
                <div class="subject-fill" style="width: ${mathStats.progressPercent}%"></div>
              </div>
              <button class="btn-continue btn-math" data-action="continue-math">
                Continue Math
              </button>
            </div>
            <div class="subject-progress-card ela">
              <div class="subject-card-header">
                <span class="subject-icon ela">📖</span>
                <span class="subject-name">ELA</span>
              </div>
              <div class="subject-card-stats">
                <div class="subject-xp">${elaXP} XP</div>
                <div class="subject-lessons">
                  ${elaStats.lessonsCompleted} / ${elaStats.totalLessons} lessons
                </div>
                <div class="subject-questions">
                  ${elaStats.correctAnswers} / ${elaStats.questionsAnswered} correct
                </div>
              </div>
              <div class="subject-progress-bar">
                <div class="subject-fill" style="width: ${elaStats.progressPercent}%"></div>
              </div>
              <button class="btn-continue btn-ela" data-action="continue-ela">
                Continue ELA
              </button>
            </div>
          </div>
        </div>

        <div class="progress-section">
          <h2>Achievements</h2>
          <div class="achievements-grid">
            ${achievements.map(a => `
              <div class="achievement-card ${a.unlocked ? 'unlocked' : 'locked'}">
                <div class="achievement-icon">${a.icon}</div>
                <div class="achievement-info">
                  <div class="achievement-label">${a.label}</div>
                  <div class="achievement-desc">${a.desc}</div>
                </div>
                <div class="achievement-status">
                  ${a.unlocked ? '✓' : '🔒'}
                </div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="progress-section">
          <h2>Recent Activity</h2>
          <div class="activity-list">
            ${recentActivity || '<p class="empty-activity">Complete a quiz to start building your progress history.</p>'}
          </div>
        </div>
      </div>
    </div>
  `;

  // onNavigate was declared in the options and never called: the continue
  // buttons only worked because main.ts re-queried the document 100ms later
  // and bound them from outside. Wiring them here, against this container,
  // removes the need to guess when the nodes are attached.
  container.querySelector('[data-action="continue-math"]')
    ?.addEventListener('click', () => options.onNavigate('math'));
  container.querySelector('[data-action="continue-ela"]')
    ?.addEventListener('click', () => options.onNavigate('ela'));

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