// src/main.ts
import './style.css';
import { seedLessons, getLessonsForGrade, createProfile, getCurrentProfile, getProgressForStudent, saveProgress, markQuestionAnswered, updateProfile, calculateStreak, getPendingSyncItems } from './db';
import { initOfflineSync, registerSyncCallbacks, getConnectionStatus, isOnline as isNetworkOnline } from '../utils/offline';
import { preloadLessons } from './preload';
import { renderOnboarding, type OnboardingData } from './screens/onboarding';
import { renderDashboard } from './screens/dashboard';
import { renderSubjectPage, renderSettingsPlaceholder } from './screens/subject';
import { renderProgressPage } from './screens/progress';
import { renderSidebar } from './components/sidebar';
import type { StudentProfile, Lesson, Grade, Language, Subject, Progress } from './types';
import { renderLessonScreen, type TutorMessage } from './screens/lesson';  // ← NEW: added TutorMessage
import { getTutorResponse } from './gemini';  // ← NEW
import { startQuiz, renderQuizScreen, renderQuizSummary, selectAnswer, useHint, goToNextQuestion, submitQuiz, getQuizProgress, calculateScore, calculateXP, getCurrentQuestion, getCurrentQuestionIndex } from './screens/quiz';
import { startBossBattle, renderBossScreen, renderBossSummary, selectBossAnswer, useBossHint, goToNextBossQuestion, calculateBossScore, calculateBossXP, isBossDefeated } from './screens/boss';


// ── App State ─────────────────────────────────────────────────────────────────

type Page = 'dashboard' | 'onboarding' | 'lesson' | 'quiz' | 'boss' | 'progress' | 'settings' | 'math' | 'ela';

let currentPage: Page = 'onboarding';
let currentSubject: Subject = 'math';
let currentLessonId: number | null = null;
let currentQuiz: ReturnType<typeof getQuizProgress> = null;
let currentBoss: ReturnType<typeof startBossBattle> | null = null;
let app: HTMLElement;
let profile: StudentProfile | null = null;
let lessons: Lesson[] = [];
let recentProgress: Progress[] = [];
let pendingSyncCount = 0;

// ── Chat State ────────────────────────────────────────────────────────────────  ← NEW
let tutorMessages: TutorMessage[] = [];
let isTutorThinking = false;

function uniqueMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function updateChatUI(): void {  // ← NEW: updates only the chat div, never re-renders whole page
  const messagesEl = document.getElementById('tutor-messages');
  if (!messagesEl) return;

  messagesEl.innerHTML = tutorMessages.map(msg => `
    <div class="${msg.role === 'mentor' ? 'tutor-message' : 'student-message'}">
      ${escapeHtml(msg.text)}
    </div>
  `).join('') + (isTutorThinking ? `
    <div class="tutor-typing">
      <span></span><span></span><span></span>
    </div>
  ` : '');

  messagesEl.scrollTop = messagesEl.scrollHeight;
}


// ── Navigation ───────────────────────────────────────────────────────────────

/**
 * Reload everything the home and progress screens read.
 *
 * Both tables matter: scores live on Progress rows, but the per-question "answered"
 * flags that decide whether a lesson is in progress live on the lesson records.
 * Always resolve this BEFORE calling render() — render() must not await between
 * clearing #app and appending, or two overlapping calls each append a layout.
 */
async function refreshStudentData(): Promise<void> {
  if (!profile) return;
  lessons          = await getLessonsForGrade(profile.grade, 'en');
  recentProgress   = await getProgressForStudent(profile.nickname);
  pendingSyncCount = (await getPendingSyncItems()).length;
}

async function navigateTo(page: string): Promise<void> {
  if (page === 'math' || page === 'ela') {
    currentSubject = page as Subject;
    if (profile) {
      lessons = await getLessonsForGrade(profile.grade, 'en');
    }
    currentPage = page as Page;
  } else if (page === 'dashboard' || page === 'progress' || page === 'settings') {
    if (page === 'dashboard' || page === 'progress') {
      await refreshStudentData();
    }
    currentPage = page as Page;
  }
  render();
}


// ── Render ────────────────────────────────────────────────────────────────────

async function render(): Promise<void> {
  app.innerHTML = '';
  const isOnline = navigator.onLine;

  if (currentPage === 'onboarding') {
    app.appendChild(renderOnboarding({ isOnline, onStart: handleOnboardingStart }));
    return;
  }

  const layout = document.createElement('div');
  layout.className = 'app-layout';

  const sidebar = renderSidebar({
    profile,
    currentPage,
    isOnline,
    onNavigate: (page) => { void navigateTo(page); }
  });

  let mainContent: HTMLElement;

  if (currentPage === 'math' || currentPage === 'ela') {
    mainContent = renderSubjectPage({
      subject: currentSubject,
      lessons: lessons.filter(l => l.subject === currentSubject),
      profile,
      isOnline,
      onSelectLesson: (lessonId) => {
        currentLessonId = lessonId;
        currentPage = 'quiz';
        render();
      },
      onStartBoss: (subject) => {
        currentSubject = subject;
        currentPage = 'boss';
        currentBoss = null;
        render();
      },
      onGoBack: () => navigateTo('dashboard'),
    });
    setupSubjectPageHandlers();
  } else if (currentPage === 'lesson' && currentLessonId) {
    const selectedLesson = lessons.find(l => l.id === currentLessonId);
    if (selectedLesson) {

      // ← NEW: seed welcome message when entering lesson fresh
      if (tutorMessages.length === 0) {
        tutorMessages = [{
          id: uniqueMessageId(),
          role: 'mentor',
          text: `Hi! I'm your MentorAI tutor. Today we're working on "${selectedLesson.title}". Ask me anything! 🧠`,
        }];
      }

      mainContent = renderLessonScreen({
        lesson: selectedLesson,
        profile,
        isOnline,
        messages: tutorMessages,          // ← NEW
        isTutorThinking: isTutorThinking, // ← NEW
        onGoBack: () => {
          tutorMessages = [];             // ← NEW: reset chat on back
          isTutorThinking = false;
          currentPage = currentSubject as Page;
          currentLessonId = null;
          render();
        },
        onTakeQuiz: () => {
          currentPage = 'quiz';
          render();
        },
        onSendMessage: async (prompt: string) => {  // ← NEW: full Gemini implementation
          tutorMessages = [
            ...tutorMessages,
            { id: uniqueMessageId(), role: 'student', text: prompt },
          ];
          isTutorThinking = true;
          updateChatUI(); // ← only update chat, not whole page

          try {
            const reply = await getTutorResponse(
              prompt,
              selectedLesson.content,
              selectedLesson.grade,
            );
            tutorMessages = [
              ...tutorMessages,
              { id: uniqueMessageId(), role: 'mentor', text: reply },
            ];
          } catch (err) {
            console.error('Gemini error:', err);
            tutorMessages = [
              ...tutorMessages,
              { id: uniqueMessageId(), role: 'mentor', text: "Sorry, I couldn't connect. Try again in a moment! 🔌" },
            ];
          } finally {
            isTutorThinking = false;
            updateChatUI();
          }
        },
      });
    } else {
      currentPage = currentSubject as Page;
      currentLessonId = null;
      render();
      return;
    }
  } else if (currentPage === 'progress') {
    mainContent = renderProgressPage({
      profile,
      lessons,
      recentProgress,
      isOnline,
      onNavigate: (subject) => { void navigateTo(subject); }
    });
    setupProgressPageHandlers();
  } else if (currentPage === 'settings') {
    mainContent = renderSettingsPlaceholder();
  } else if (currentPage === 'boss' && profile) {
    const subjectLessons = lessons.filter(l => l.subject === currentSubject);
    if (subjectLessons.length > 0) {
      const bossState = currentBoss || startBossBattle(subjectLessons, currentSubject);
      if (!currentBoss) currentBoss = bossState;
      const currentProfile = profile;

      const handleBossNext = async () => {
        const defeated = isBossDefeated();
        if (defeated) {
          const bossScore = calculateBossScore();
          const answered = bossState.answers.length;
          const bossXP = calculateBossXP(bossScore, answered);
          if (currentProfile) {
            await saveProgress({
              nickname: currentProfile.nickname,
              lessonId: 99999,
              lessonTitle: `${currentSubject} Boss Battle`,
              subject: currentSubject as Subject,
              score: bossScore,
              xpEarned: bossXP,
              attempts: answered,
              hintsUsed: bossState.hintsUsed,
              completedAt: new Date().toISOString(),
            });
            currentProfile.totalXP += bossXP;
            if (currentSubject === 'math') {
              currentProfile.mathXP = (currentProfile.mathXP ?? 0) + bossXP;
            } else {
              currentProfile.elaXP = (currentProfile.elaXP ?? 0) + bossXP;
            }
          }
          app.innerHTML = '';
          app.appendChild(
            renderBossSummary(bossScore, bossXP, bossState.hintsUsed, answered, () => {
              currentPage = 'dashboard';
              currentBoss = null;
              render();
            })
          );
          return;
        }
        const moved = goToNextBossQuestion();
        if (moved) {
          render();
        } else {
          const bossScore = calculateBossScore();
          const answered = bossState.answers.length;
          const bossXP = calculateBossXP(bossScore, answered);
          if (currentProfile) {
            await saveProgress({
              nickname: currentProfile.nickname,
              lessonId: 99999,
              lessonTitle: `${currentSubject} Boss Battle`,
              subject: currentSubject as Subject,
              score: bossScore,
              xpEarned: bossXP,
              attempts: answered,
              hintsUsed: bossState.hintsUsed,
              completedAt: new Date().toISOString(),
            });
            currentProfile.totalXP += bossXP;
            if (currentSubject === 'math') {
              currentProfile.mathXP = (currentProfile.mathXP ?? 0) + bossXP;
            } else {
              currentProfile.elaXP = (currentProfile.elaXP ?? 0) + bossXP;
            }
          }
          app.innerHTML = '';
          app.appendChild(
            renderBossSummary(bossScore, bossXP, bossState.hintsUsed, answered, () => {
              currentPage = 'dashboard';
              currentBoss = null;
              render();
            })
          );
        }
      };

      mainContent = renderBossScreen({
        subject: currentSubject,
        onSelectAnswer: (index) => { selectBossAnswer(index); },
        onUseHint: () => { useBossHint(); },
        onNext: handleBossNext,
        onFinish: () => { handleBossNext(); },
        onTimeUp: () => {
          app.innerHTML = '';
          app.appendChild(
            renderBossSummary(0, 0, bossState.hintsUsed, bossState.answers.length, () => {
              currentPage = 'dashboard';
              currentBoss = null;
              render();
            })
          );
        },
        onGoBack: () => {
          currentPage = 'dashboard';
          currentBoss = null;
          render();
        },
      });
    } else {
      mainContent = document.createElement('div');
      mainContent.textContent = 'No lessons available for boss battle';
    }
  } else if (currentPage === 'quiz' && currentLessonId && profile) {
    const selectedLesson = lessons.find(l => l.id === currentLessonId);
    if (selectedLesson && profile) {
      if (!currentQuiz) {
        currentQuiz = await startQuiz(selectedLesson, { hintsRemaining: 3 });
      }

      const handleNext = async () => {
        const moved = goToNextQuestion();
        if (moved) {
          currentQuiz = getQuizProgress();
          render();
        } else {
          const quizState = getQuizProgress();
          if (quizState) {
            const score = calculateScore();
            const xpEarned = calculateXP(score);
            await saveProgressRecord(selectedLesson, score, xpEarned, quizState.hintsUsed);
            submitQuiz(profile!.nickname, selectedLesson.title, currentSubject);
            currentQuiz = null;
            app.innerHTML = '';
            app.appendChild(
              renderQuizSummary(score, xpEarned, quizState.hintsUsed, selectedLesson.questions.length, () => {
                currentPage = currentSubject as Page;
                currentLessonId = null;
                render();
              })
            );
            return;
          }
        }
      };

      mainContent = renderQuizScreen({
        onSelectAnswer: (index) => {
          selectAnswer(index);
          void recordAnswer(selectedLesson, index);
        },
        onUseHint: () => { useHint(); },
        onNext: handleNext,
        onFinish: () => { handleNext(); },
        onGoBack: () => {
          currentPage = 'lesson';
          currentQuiz = null;
          render();
        },
      });
    } else {
      mainContent = document.createElement('div');
      mainContent.textContent = 'No lesson selected';
    }
  } else {
    mainContent = renderDashboard({
      profile,
      lessons,
      progress: recentProgress,
      isOnline,
      pendingSyncCount,
      onSelectLesson: (lessonId) => {
        currentLessonId = lessonId;
        currentPage = 'quiz';
        render();
      },
    });
  }

  layout.appendChild(sidebar);
  layout.appendChild(mainContent);
  app.appendChild(layout);
}


// ── Quiz Progress ─────────────────────────────────────────────────────────────

/**
 * Record an answer to IndexedDB and let the sync engine queue any Gemini follow-up.
 *
 * Deliberately fire-and-forget: answering must stay instant and must never fail
 * because a write or a queue push failed. The student action is the source of
 * truth; network work is queued behind it and drains later.
 */
async function recordAnswer(lesson: Lesson, answerIndex: number): Promise<void> {
  if (lesson.id === undefined) return;

  const question = getCurrentQuestion();
  if (!question) return;

  try {
    await markQuestionAnswered(
      lesson.id,
      getCurrentQuestionIndex(),
      answerIndex === question.correctIndex
    );
  } catch (err) {
    console.error('[Quiz] Failed to record answer:', err);
  }
}

async function saveProgressRecord(lesson: Lesson, score: number, xpEarned: number, hintsUsed: number): Promise<void> {
  const currentProfile = profile;
  if (!currentProfile) return;

  await saveProgress({
    nickname: currentProfile.nickname,
    lessonId: lesson.id!,
    lessonTitle: lesson.title,
    subject: lesson.subject,
    score,
    xpEarned,
    attempts: lesson.questions.length,
    hintsUsed,
    completedAt: new Date().toISOString(),
  });

  currentProfile.totalXP += xpEarned;
  if (lesson.subject === 'math') {
    currentProfile.mathXP = (currentProfile.mathXP ?? 0) + xpEarned;
  } else {
    currentProfile.elaXP = (currentProfile.elaXP ?? 0) + xpEarned;
  }
}


// ── Onboarding ────────────────────────────────────────────────────────────────

/** Create the local profile and drop the student on the dashboard. */
async function handleOnboardingStart(data: OnboardingData): Promise<void> {
  if (!data.nickname || !data.grade) return;

  const newProfile: Omit<StudentProfile, 'id'> = {
    nickname:     data.nickname,
    grade:        data.grade as Grade,
    language:     'en' as Language,
    totalXP:      0,
    mathXP:       0,
    elaXP:        0,
    currentLevel: 1,
    streak:       1,   // creating a profile counts as being active today
    lastActive:   new Date().toISOString(),
  };

  const id = await createProfile(newProfile);
  profile = { ...newProfile, id };
  await refreshStudentData();
  currentPage = 'dashboard';
  render();
}

/**
 * Roll the daily streak forward and stamp today as the last active day.
 * calculateStreak() already handles all three cases: same day leaves it alone,
 * the next day increments, any longer gap resets to 1.
 */
async function tickStreak(): Promise<void> {
  if (!profile) return;
  const streak = calculateStreak(profile.lastActive, profile.streak);
  const lastActive = new Date().toISOString();
  await updateProfile(profile.nickname, { streak, lastActive });
  profile = { ...profile, streak, lastActive };
}

function setupSubjectPageHandlers(): void {
  setTimeout(() => {
    const backBtn = document.querySelector('[data-action="back"]');
    backBtn?.addEventListener('click', () => navigateTo('dashboard'));

    const startLessonBtns = document.querySelectorAll('[data-action^="start-lesson-"]');
    startLessonBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLElement;
        const lessonId = parseInt(target.dataset.action!.replace('start-lesson-', ''), 10);
        currentLessonId = lessonId;
        currentPage = 'lesson';
        render();
      });
    });
  }, 100);
}

function setupProgressPageHandlers(): void {
  setTimeout(() => {
    document.querySelector('[data-action="continue-math"]')?.addEventListener('click', () => {
      currentSubject = 'math';
      navigateTo('math');
    });
    document.querySelector('[data-action="continue-ela"]')?.addEventListener('click', () => {
      currentSubject = 'ela';
      navigateTo('ela');
    });
  }, 100);
}


// ── Sync Badge ────────────────────────────────────────────────────────────────

/**
 * The one always-visible signal that the sync engine is alive: a dot that is
 * green online, red offline, and pulses gold while the queue drains.
 *
 * Mounted on <body> rather than #app because every navigation replaces the app
 * root's innerHTML wholesale, which would destroy the badge mid-drain.
 */
function mountSyncBadge(): void {
  const badge = document.createElement('div');
  badge.className = 'sync-badge';
  badge.innerHTML = '<span class="sync-dot"></span>';
  document.body.appendChild(badge);

  const paint = (status: 'online' | 'offline' | 'syncing'): void => {
    badge.dataset.status = status;
  };

  // Safe here: nothing is draining yet at mount time.
  paint(getConnectionStatus());

  // The drain's finally-block clears its in-progress flag *after* these fire, so
  // getConnectionStatus() would still answer 'syncing' and strand the dot gold.
  // Read the connection directly instead.
  const settle = (): void => paint(isNetworkOnline() ? 'online' : 'offline');

  registerSyncCallbacks({
    onStatusChange: (online) => paint(online ? 'online' : 'offline'),
    onSyncStart:    () => paint('syncing'),
    onSyncError:    settle,
    onSyncComplete: (count) => {
      settle();
      // The dashboard's "N items waiting to sync" banner reads a count captured
      // at render time. Refresh it only while it is actually on screen —
      // re-rendering mid-quiz would throw away the student's place.
      if (count > 0 && currentPage === 'dashboard') {
        void refreshStudentData().then(() => render());
      }
    },
  });
}


// ── Event Delegation ──────────────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const button = target.closest('[data-page]') || target.closest('[data-action]') || target.closest('[data-route]');
  if (!button) return;
  const page = (button as HTMLElement).dataset.page || (button as HTMLElement).dataset.action || (button as HTMLElement).dataset.route;
  if (page) {
    e.preventDefault();
    void navigateTo(page);
  }
});


// ── Boot ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  app = document.getElementById('app')!;
  await seedLessons();
  mountSyncBadge();   // must precede initOfflineSync — that call can drain immediately
  initOfflineSync();
  preloadLessons().catch(console.error);

  // A returning student skips onboarding. Without this every reload created a
  // duplicate profile row and reset the streak.
  profile = (await getCurrentProfile()) ?? null;
  if (profile) {
    await tickStreak();
    await refreshStudentData();
    currentPage = 'dashboard';
  }

  window.addEventListener('online',  () => render());
  window.addEventListener('offline', () => render());
  console.log('[MentorAI] Boot complete');
  render();
}

init().catch(console.error);

export {};