// src/screens/onboarding.ts
//
// First-launch screen: the student picks a nickname and a grade, and we create
// their local profile. There are no accounts and no password — the nickname is
// the only identity this app has.

export interface OnboardingData {
  nickname: string;
  grade: number | null;
}

export interface OnboardingOptions {
  /** Drives the status line in the brand panel. */
  isOnline: boolean;
  /** Called once the student has a valid nickname + grade and taps through. */
  onStart: (data: OnboardingData) => void;
}


// ── State ─────────────────────────────────────────────────────────────────────

// Module-level so a re-render doesn't wipe what the student already typed.
// main.ts re-renders on every `online`/`offline` event, and on this app those
// events are expected to fire mid-onboarding.
const state: OnboardingData = {
  nickname: '',
  grade: null,
};


// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Build the onboarding screen: teal brand panel on the left, form on the right.
 * Returns a detached element with its listeners already attached.
 */
export function renderOnboarding(options: OnboardingOptions): HTMLElement {
  const { isOnline, onStart } = options;

  const container = document.createElement('div');
  container.className = 'onboarding-screen';
  container.innerHTML = `
    <div class="onboarding-brand">
      <div class="brand-row">
        <div class="brand-mark">M</div>
        <div class="brand-word">MentorAI</div>
      </div>

      <div class="brand-pitch">
        <h2>A tutor that keeps working when the internet doesn't.</h2>
        <p>
          Lessons for grades 6&ndash;8 are cached on your device. Answer offline,
          and everything syncs the next time you connect.
        </p>
      </div>

      <div class="brand-net" data-online="${isOnline}">
        <span class="brand-net-dot"></span>
        <span>${isOnline ? 'online · lessons up to date' : 'offline · cached lessons ready'}</span>
      </div>
    </div>

    <div class="onboarding-panel">
      <div class="onboarding-form">
        <div class="onboarding-heading">
          <h1 class="onboarding-title">Let's get started</h1>
          <p class="onboarding-subtitle">Two things and you're learning.</p>
        </div>

        <div class="form-group">
          <label class="form-label" for="nickname-input">What should we call you?</label>
          <input
            type="text"
            id="nickname-input"
            class="form-input"
            placeholder="e.g. aanya"
            maxlength="20"
            autocomplete="off"
          >
        </div>

        <div class="form-group">
          <label class="form-label">Your grade</label>
          <div class="grade-buttons">
            <button type="button" class="grade-btn" data-grade="6">Grade 6</button>
            <button type="button" class="grade-btn" data-grade="7">Grade 7</button>
            <button type="button" class="grade-btn" data-grade="8">Grade 8</button>
          </div>
        </div>

        <button type="button" class="onboarding-submit" id="start-btn" disabled>
          Start Learning
        </button>

        <p class="onboarding-note">
          Your progress is saved on this device. You can keep learning without a
          connection.
        </p>
      </div>
    </div>
  `;

  const nicknameInput = container.querySelector('#nickname-input') as HTMLInputElement;
  const startBtn = container.querySelector('#start-btn') as HTMLButtonElement;
  const gradeBtns = container.querySelectorAll<HTMLButtonElement>('.grade-btn');

  // Restore anything the student had already entered before the last re-render.
  nicknameInput.value = state.nickname;
  gradeBtns.forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.grade) === state.grade);
  });
  updateStartButton();

  nicknameInput.addEventListener('input', () => {
    state.nickname = nicknameInput.value.trim();
    updateStartButton();
  });

  gradeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      state.grade = Number(btn.dataset.grade);
      gradeBtns.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      updateStartButton();
    });
  });

  startBtn.addEventListener('click', () => {
    if (!state.nickname || !state.grade) return;
    onStart({ ...state });
  });

  function updateStartButton(): void {
    startBtn.disabled = !state.nickname || !state.grade;
  }

  return container;
}
