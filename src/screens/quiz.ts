import type { Lesson, Question, Subject } from '../types';
import { escapeHtml } from '../utils/escape';

export interface QuizState {
  lesson: Lesson;
  currentQuestionIndex: number;
  answers: (number | null)[];
  hintsUsed: number;
  startTime: number;
  hintsRemaining: number;
}

let currentQuiz: QuizState | null = null;

export function getHintTokenCount(profile: { hintsRemaining: number }): number {
  return profile.hintsRemaining || 0;
}

export async function startQuiz(lesson: Lesson, profile: { hintsRemaining: number }): Promise<QuizState> {
  currentQuiz = {
    lesson,
    currentQuestionIndex: 0,
    answers: new Array(lesson.questions.length).fill(null),
    hintsUsed: 0,
    startTime: Date.now(),
    hintsRemaining: profile.hintsRemaining,
  };
  return currentQuiz;
}

export function getCurrentQuestion(): Question | null {
  if (!currentQuiz) return null;
  return currentQuiz.lesson.questions[currentQuiz.currentQuestionIndex];
}

export function getCurrentQuestionIndex(): number {
  if (!currentQuiz) return 0;
  return currentQuiz.currentQuestionIndex;
}

export function getTotalQuestions(): number {
  if (!currentQuiz) return 0;
  return currentQuiz.lesson.questions.length;
}

export function selectAnswer(answerIndex: number): void {
  if (!currentQuiz) return;
  currentQuiz.answers[currentQuiz.currentQuestionIndex] = answerIndex;
}

export function getSelectedAnswer(): number | null {
  if (!currentQuiz) return null;
  return currentQuiz.answers[currentQuiz.currentQuestionIndex];
}

export function getHint(): string | null {
  if (!currentQuiz) return null;
  const question = getCurrentQuestion();
  return question?.hint || null;
}

export function useHint(): boolean {
  if (!currentQuiz) return false;
  if (currentQuiz.hintsRemaining <= 0) return false;
  if (currentQuiz.hintsUsed >= 1) return false;
  
  currentQuiz.hintsUsed++;
  currentQuiz.hintsRemaining--;
  return true;
}

export function goToNextQuestion(): boolean {
  if (!currentQuiz) return false;
  if (!hasAnsweredCurrent()) return false;
  if (currentQuiz.currentQuestionIndex >= currentQuiz.lesson.questions.length - 1) {
    return false;
  }
  currentQuiz.currentQuestionIndex++;
  return true;
}

export function goToPreviousQuestion(): boolean {
  if (!currentQuiz) return false;
  if (currentQuiz.currentQuestionIndex <= 0) return false;
  currentQuiz.currentQuestionIndex--;
  return true;
}

export function hasAnsweredCurrent(): boolean {
  if (!currentQuiz) return false;
  return currentQuiz.answers[currentQuiz.currentQuestionIndex] !== null;
}

export function allQuestionsAnswered(): boolean {
  if (!currentQuiz) return false;
  return currentQuiz.answers.every(a => a !== null);
}

export function calculateScore(): number {
  if (!currentQuiz) return 0;
  
  let correct = 0;
  for (let i = 0; i < currentQuiz.lesson.questions.length; i++) {
    const question = currentQuiz.lesson.questions[i];
    if (currentQuiz.answers[i] === question.correctIndex) {
      correct++;
    }
  }
  
  return Math.round((correct / currentQuiz.lesson.questions.length) * 100);
}

export function calculateXP(score: number): number {
  if (score >= 100) return 50;
  if (score >= 80) return 40;
  if (score >= 60) return 25;
  if (score >= 40) return 15;
  return 10;
}

export function getQuizProgress(): QuizState | null {
  return currentQuiz;
}

export function getQuestionProgress(): { current: number; total: number; answered: number } {
  if (!currentQuiz) return { current: 0, total: 0, answered: 0 };
  return {
    current: currentQuiz.currentQuestionIndex + 1,
    total: currentQuiz.lesson.questions.length,
    answered: currentQuiz.answers.filter(a => a !== null).length,
  };
}

export async function submitQuiz(
  _nickname: string,
  _lessonTitle: string,
  _subject: Subject
): Promise<{ score: number; xpEarned: number; hintsUsed: number }> {
  if (!currentQuiz) throw new Error('No active quiz');
  
  const score = calculateScore();
  const xpEarned = calculateXP(score);
  const hintsUsed = currentQuiz.hintsUsed;
  
  currentQuiz = null;
  
  return { score, xpEarned, hintsUsed };
}

interface QuizRenderOptions {
  onSelectAnswer: (index: number) => void;
  onUseHint: () => void;
  onNext: () => void;
  onFinish: () => void;
  onGoBack: () => void;
}

export function renderQuizScreen(options: QuizRenderOptions): HTMLElement {
  if (!currentQuiz) {
    return document.createElement('div');
  }

  const container = document.createElement('div');
  container.className = 'app-layout';
  
  const question = getCurrentQuestion();
  const questionIndex = getCurrentQuestionIndex();
  const totalQuestions = getTotalQuestions();
  getSelectedAnswer();
  const progress = ((questionIndex + 1) / totalQuestions) * 100;
  const currentHint = getHint();

  if (!question) {
    return document.createElement('div');
  }

  container.innerHTML = `
    <div class="main-content">
      <div class="quiz-content">
        <div class="quiz-header-row">
          <div class="question-label">Question ${questionIndex + 1} of ${totalQuestions}</div>
        </div>
        
        <div class="quiz-bar-track">
          <div class="quiz-bar-fill" data-quiz-progress="${progress}%"></div>
        </div>
        
        <div class="quiz-card">
          <div class="question-text">${escapeHtml(question?.prompt || '')}</div>
          
          <div class="choices-grid">
            ${(question?.choices || []).map((choice, i) => `
              <button class="choice-btn" data-choice="${i}">${escapeHtml(choice)}</button>
            `).join('')}
          </div>
          
          <div class="hint-popup" id="hint-popup" style="display: none;">
            <strong>💡 Hint:</strong> ${escapeHtml(currentHint || '')}
          </div>
        </div>
        
        <div class="quiz-footer">
          <button class="hint-btn" id="hint-btn">
            💡 Hint (${currentQuiz.hintsRemaining} token)
          </button>
          <button class="next-btn" id="next-btn" disabled>
            ${questionIndex + 1 >= totalQuestions ? 'Finish' : 'Next'} →
          </button>
        </div>
      </div>
    </div>
  `;

  setTimeout(() => {
    const progressFill = container.querySelector('[data-quiz-progress]') as HTMLElement;
    if (progressFill && progressFill.dataset.quizProgress) {
      progressFill.style.width = progressFill.dataset.quizProgress;
    }
  }, 100);

  const choiceBtns = container.querySelectorAll('.choice-btn');
  const nextBtn = container.querySelector('#next-btn') as HTMLButtonElement;
  const hintBtn = container.querySelector('#hint-btn') as HTMLButtonElement;
  const hintPopup = container.querySelector('#hint-popup') as HTMLElement;

  choiceBtns.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = e.currentTarget as HTMLButtonElement;
      const choiceIdx = parseInt(target.dataset.choice || '0');
      
      // Check if answer is correct and show feedback
      const isCorrect = choiceIdx === question.correctIndex;
      choiceBtns.forEach(b => b.classList.remove('selected', 'correct', 'incorrect'));
      
      if (isCorrect) {
        target.classList.add('correct');
      } else {
        target.classList.add('wrong');
        // Also highlight the correct answer
        const correctBtn = container.querySelector(`[data-choice="${question.correctIndex}"]`);
        correctBtn?.classList.add('correct');
      }
      
      options.onSelectAnswer(choiceIdx);
      
      if (nextBtn) {
        nextBtn.disabled = false;
      }
      
      // Disable all choice buttons after selection
      choiceBtns.forEach((b: Element) => {
        (b as HTMLButtonElement).disabled = true;
      });
    });
  });

  const savedAnswer = getSelectedAnswer();
  if (savedAnswer !== null) {
    const savedBtn = container.querySelector(`[data-choice="${savedAnswer}"]`);
    savedBtn?.classList.add('selected');
    if (nextBtn) nextBtn.disabled = false;
  }

  hintBtn?.addEventListener('click', () => {
    options.onUseHint();
    if (hintPopup && getHint()) {
      hintPopup.style.display = 'block';
      hintPopup.querySelector('strong')!.nextSibling!.textContent = `: ${getHint()}`;
    }
  });

  nextBtn?.addEventListener('click', () => {
    if (questionIndex + 1 >= totalQuestions) {
      options.onFinish();
    } else {
      options.onNext();
    }
  });

  return container;
}

export function renderQuizSummary(score: number, xpEarned: number, hintsUsed: number, totalQuestions: number, onBackToDashboard: () => void): HTMLElement {
  const container = document.createElement('div');
  container.className = 'app-layout';
  
  const correct = Math.round((score / 100) * totalQuestions);
  const grade = score >= 90 ? 'Excellent!' : score >= 70 ? 'Great Job!' : score >= 50 ? 'Good Effort!' : 'Keep Practicing!';
  
  container.innerHTML = `
    <div class="main-content">
      <div class="quiz-summary">
        <div class="summary-card">
          <div class="summary-score-circle">
            <div class="summary-score-number">${score}%</div>
            <div class="summary-score-pct">${correct}/${totalQuestions} correct</div>
          </div>
          
          <div class="summary-grade">${grade}</div>
          
          <div class="summary-stats-grid">
            <div class="summary-stat">
              <div class="summary-stat-label">Correct</div>
              <div class="summary-stat-value">${correct}</div>
            </div>
            <div class="summary-stat">
              <div class="summary-stat-label">Hints</div>
              <div class="summary-stat-value">${hintsUsed}</div>
            </div>
            <div class="summary-stat">
              <div class="summary-stat-label">XP</div>
              <div class="summary-stat-value">+${xpEarned}</div>
            </div>
          </div>
          
          <div class="xp-badge">⭐ +${xpEarned} XP Earned!</div>
          
          <button class="btn-back-dashboard" id="back-dashboard-btn">
            Back to Dashboard
          </button>
        </div>
      </div>
    </div>
  `;

  const backBtn = container.querySelector('#back-dashboard-btn');
  backBtn?.addEventListener('click', onBackToDashboard);

  return container;
}