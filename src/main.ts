// src/main.ts
import './style.css';
import { seedLessons, getLessons, createProfile, getProgressForStudent, saveProgress } from './db';
import { initOfflineSync } from '../utils/offline';
import { preloadLessons } from './preload';
import { renderOnboarding, state as onboardingState } from './screens/onboarding';
import { renderDashboard } from './screens/dashboard';
import { renderSubjectPage, renderSettingsPlaceholder } from './screens/subject';
import { renderProgressPage } from './screens/progress';
import { renderSidebar } from './components/sidebar';
import type { StudentProfile, Lesson, Grade, Language, Subject, Progress } from './types';
import { renderLessonScreen, type TutorMessage } from './screens/lesson';  // ← NEW: added TutorMessage
import { getTutorResponse } from './gemini';  // ← NEW
import { startQuiz, renderQuizScreen, renderQuizSummary, selectAnswer, useHint, goToNextQuestion, submitQuiz, getQuizProgress, calculateScore, calculateXP } from './screens/quiz';
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

async function navigateTo(page: string): Promise<void> {
  if (page === 'math' || page === 'ela') {
    currentSubject = page as Subject;
    if (profile) {
      lessons = await getLessons(profile.grade, page as Subject, 'en');
    }
    currentPage = page as Page;
  } else if (page === 'dashboard' || page === 'progress' || page === 'settings') {
    currentPage = page as Page;
  }
  render();
}


// ── Render ────────────────────────────────────────────────────────────────────

async function render(): Promise<void> {
  app.innerHTML = '';
  const isOnline = navigator.onLine;

  if (currentPage === 'onboarding') {
    app.appendChild(renderOnboarding());
    setupOnboardingHandlers();
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
        onSelectAnswer: (index) => { selectAnswer(index); },
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
      isOnline,
      onOpenLesson: (subject) => { void navigateTo(subject); }
    });
  }

  layout.appendChild(sidebar);
  layout.appendChild(mainContent);
  app.appendChild(layout);
}


// ── Quiz Progress ─────────────────────────────────────────────────────────────

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

function setupOnboardingHandlers(): void {
  setTimeout(() => {
    const startBtn = document.getElementById('start-btn');
    if (!startBtn) { setTimeout(setupOnboardingHandlers, 200); return; }

    startBtn.addEventListener('click', async () => {
      if (!onboardingState.nickname || !onboardingState.grade) return;

      const newProfile: Omit<StudentProfile, 'id'> = {
        nickname:     onboardingState.nickname,
        grade:        onboardingState.grade as Grade,
        language:     'en' as Language,
        totalXP:      0,
        mathXP:       0,
        elaXP:        0,
        currentLevel: 1,
        streak:       0,
        lastActive:   new Date().toISOString(),
      };

      await createProfile(newProfile);
      profile = { ...newProfile, id: 1 } as StudentProfile;
      lessons = await getLessons(profile.grade, 'math', 'en');
      recentProgress = await getProgressForStudent(profile.nickname);
      currentPage = 'dashboard';
      render();
    });
  }, 100);
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
  initOfflineSync();
  preloadLessons().catch(console.error);
  window.addEventListener('online',  () => render());
  window.addEventListener('offline', () => render());
  console.log('[MentorAI] Boot complete');
  render();
}

init().catch(console.error);

export {};