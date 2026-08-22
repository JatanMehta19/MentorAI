// src/utils/escape.ts

/**
 * Escape a string for interpolation into an HTML template.
 *
 * Every screen builds its markup with template strings and assigns it through
 * `innerHTML`, so an interpolated value is parsed as markup unless it comes
 * through here first.
 *
 * The untrusted input is not just the student's nickname. Lesson titles, question
 * prompts, answer choices and hints are model output, and they reach the DOM by
 * exactly the same route — a prompt-injected or simply malformed completion is
 * markup if nothing escapes it. Treat anything that came from Gemini or from a
 * text field as hostile.
 *
 * Replaces the five characters that matter in element content *and* inside a
 * quoted attribute value, so one function covers both positions. `&` goes first;
 * reordering it would double-escape the entities the later rules introduce.
 *
 * This lived as three identical private copies — in main.ts, dashboard.ts and
 * lesson.ts — which is how it ended up applied at only 6 of 33 interpolation
 * sites. One exported function is harder to forget.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
