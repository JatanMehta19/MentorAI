import type { Lesson, StudentProfile } from '../types.ts';
import { escapeHtml } from '../utils/escape';

export interface TutorMessage {
  id: string;
  role: 'mentor' | 'student';
  text: string;
}

interface LessonScreenOptions {
  lesson: Lesson;
  profile: StudentProfile | null;
  isOnline: boolean;
  messages: TutorMessage[];
  isTutorThinking: boolean;
  onGoBack: () => void;
  onTakeQuiz: () => void;
  onSendMessage: (prompt: string) => Promise<void>;
}

export function renderLessonScreen(options: LessonScreenOptions): HTMLElement {
  const container = document.createElement('div');
  container.className = 'app-layout';
  
  const lesson = options.lesson;
  const isMath = lesson.subject === 'math';
  const metaClass = isMath ? '' : 'ela';
  const btnClass = isMath ? '' : 'ela';
  const content = lesson.content.split('\n\n').filter(Boolean);
  
  container.innerHTML = `
    <div class="main-content">
      <div class="page-center">
        <div class="lesson-layout">
          <div class="lesson-panel">
            <div class="lesson-meta ${metaClass}">${lesson.subject.toUpperCase()} · Grade ${lesson.grade}</div>
            <h1 class="lesson-title">${escapeHtml(lesson.title)}</h1>
            
            <div class="lesson-body">
              ${content.map((para, i) => `
                <div class="lesson-content-card">
                  <div class="lesson-content-title">${i === 0 ? 'Overview' : 'Step ' + i}</div>
                  <div class="lesson-content-text">${escapeHtml(para)}</div>
                </div>
              `).join('')}
            </div>
            
            <div class="lesson-footer">
              <button class="btn-take-quiz ${btnClass}" id="take-quiz-btn">
                Take Quiz →
              </button>
            </div>
          </div>
          
          <div class="tutor-panel">
            <div class="tutor-header">
              <div class="tutor-identity">
                <div class="tutor-avatar">🧠</div>
                <div>
                  <div class="tutor-name">MentorAI Tutor</div>
                  <div class="tutor-status ${options.isOnline ? '' : 'offline'}">${options.isOnline ? 'Online' : 'Offline'}</div>
                </div>
              </div>
              <div class="tutor-tokens">💡 3</div>
            </div>
            
            <div class="tutor-messages" id="tutor-messages">
              ${options.messages.map(msg => `
                <div class="${msg.role === 'mentor' ? 'tutor-message' : 'student-message'}">
                  ${escapeHtml(msg.text)}
                </div>
              `).join('')}
              ${options.isTutorThinking ? `
                <div class="tutor-typing">
                  <span></span>
                  <span></span>
                  <span></span>
                </div>
              ` : ''}
            </div>
            
            <div class="tutor-input-area">
              <input type="text" class="tutor-input" id="tutor-input" placeholder="Ask me anything..." ${options.isOnline ? '' : 'disabled'}>
              <button class="tutor-send" id="tutor-send-btn" ${options.isOnline ? '' : 'disabled'}>➤</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  const takeQuizBtn = container.querySelector('#take-quiz-btn');
  takeQuizBtn?.addEventListener('click', () => {
    options.onTakeQuiz();
  });

  const tutorInput = container.querySelector('#tutor-input') as HTMLInputElement;
  const tutorSendBtn = container.querySelector('#tutor-send-btn');

  tutorSendBtn?.addEventListener('click', async () => {
    const text = tutorInput?.value.trim();
    if (text) {
      tutorInput.value = '';
      await options.onSendMessage(text);
    }
  });

  tutorInput?.addEventListener('keypress', async (e) => {
    if (e.key === 'Enter') {
      const text = tutorInput.value.trim();
      if (text) {
        tutorInput.value = '';
        await options.onSendMessage(text);
      }
    }
  });

  setTimeout(() => {
    const messages = container.querySelector('#tutor-messages');
    if (messages) {
      messages.scrollTop = messages.scrollHeight;
    }
  }, 100);

  return container;
}