// src/gemini.ts
import type { Lesson, Subject, Grade, Language, Question } from './types';
import { isValidQuestion, isValidLessonResponse, asFreshQuestion, parseJsonLoosely } from './utils/validate';

// The API key lives server-side in api/gemini.ts and is never shipped to the
// browser. Anything read via import.meta.env.VITE_* is inlined into the public
// bundle at build time, so the key must never come back here.
//
// Prompt text is not built here either. This module names an action and passes
// typed parameters; api/prompts.ts assembles the prompt. That is what stops the
// deployed function being a general-purpose Gemini relay, and it keeps the
// prompts out of the public bundle as a side effect.
const PROXY_URL  = '/api/gemini';
// Deliberately longer than the proxy's own 30s upstream timeout. When the two
// were both 15s they raced, and the client usually won — turning a clean 504
// from the proxy into an opaque AbortError with nothing to report. Let the
// server time out first; this is only a backstop for a hung proxy.
const TIMEOUT_MS = 35000;

// ── Errors ───────────────────────────────────────────────────────────────

/**
 * A rejection the proxy answered with, as opposed to a network failure that
 * never got a reply.
 *
 * The status is what lets a caller tell "try later" from "this will fail the
 * same way every time". Without it every failure looked alike, so a quota
 * rejection got queued for retry and reported to the student as being offline.
 */
export class ProxyError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name   = 'ProxyError';
    this.status = status;
  }
}

/**
 * True when retrying cannot change the outcome.
 *
 * Any 4xx: the request itself was refused. Queueing one spends all three
 * retries re-sending something the proxy has already turned down. 5xx and
 * network errors are transient and *should* be queued.
 */
export function isPermanentFailure(err: unknown): boolean {
  return err instanceof ProxyError && err.status >= 400 && err.status < 500;
}

/** True when the request was refused on rate or quota grounds. */
export function isRateLimitFailure(err: unknown): boolean {
  return err instanceof ProxyError && err.status === 429;
}

// ── Core Fetch ────────────────────────────────────────────────────────────────

/** Ask the proxy to run `action`, and return the model's text. */
async function callGemini(action: string, params: Record<string, unknown>): Promise<string> {
  // The sync queue drains serially, so one hung request would stall every
  // item behind it.
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action, params }),
      signal:  controller.signal,
    });

    const data = await res.json().catch(() => null) as
      { text?: string; error?: string } | null;

    if (!res.ok) {
      throw new ProxyError(data?.error ?? `Gemini proxy error: ${res.status}`, res.status);
    }
    if (typeof data?.text !== 'string') {
      throw new Error('Gemini proxy returned no text.');
    }

    return data.text;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Lesson Generation ─────────────────────────────────────────────────────────

/**
 * Ask Gemini to generate a full lesson for one of the catalogue topics.
 *
 * `topicIndex` selects from the shared list in src/topics.ts, and the proxy
 * resolves it against its own copy — so no caller-supplied text reaches the
 * prompt.
 *
 * Throws when the model returns something unusable. The sync queue treats a
 * throw as a failed item and retries it, which is the right handling: a
 * malformed completion is a transient fault, not a reason to crash the caller.
 */
export async function generateLesson(
  subject:    Subject,
  grade:      Grade,
  topicIndex: number,
  language:   Language
): Promise<Omit<Lesson, 'id'>> {

  const raw    = await callGemini('generate_lesson', { subject, grade, topicIndex });
  const parsed = parseJsonLoosely(raw);

  // `as GeminiLessonResponse` used to be the only check here — a promise to the
  // compiler rather than a look at the value.
  if (!isValidLessonResponse(parsed)) {
    throw new Error('Gemini returned a malformed lesson.');
  }

  return {
    subject,
    grade,
    language,
    title:       parsed.title,
    content:     parsed.content,
    questions:   parsed.questions.map(asFreshQuestion),
    createdAt:   new Date().toISOString(),
    isPreloaded: false,
  };
}

// ── Question Replacement ────────────────────────────────────────────────────────

/**
 * Ask Gemini for a single harder replacement question.
 * Only called when a student answers a question correctly.
 *
 * Throws on malformed output for the same reason as generateLesson. An
 * out-of-range correctIndex would otherwise produce a question the student
 * cannot answer correctly, and grading would go looking for a choice button that
 * is not in the DOM.
 */
export async function replaceQuestion(
  subject:           Subject,
  grade:             Grade,
  currentDifficulty: 1 | 2 | 3
): Promise<Question> {
  const raw    = await callGemini('replace_question', { subject, grade, currentDifficulty });
  const parsed = parseJsonLoosely(raw);

  if (!isValidQuestion(parsed)) {
    throw new Error('Gemini returned a malformed question.');
  }

  return asFreshQuestion(parsed);
}

/**
 * Get a tutor response for a student's live question.
 * Returns an offline message immediately if no internet — never queued.
 */
export async function getTutorResponse(
  studentQuestion: string,
  lessonContext:   string,
  grade:           Grade
): Promise<string> {
  if (!navigator.onLine) {
    return "No internet right now — ask me again when you're connected! 🔌";
  }

  return await callGemini('tutor_response', { studentQuestion, lessonContext, grade });
}

// ── Progress Report ───────────────────────────────────────────────────────────

/**
 * Generates a plain-English progress report for a teacher or parent.
 * Called by the sync engine in offline.ts when the device reconnects.
 */
export async function generateProgressReport(
  nickname: string,
  scores:   { lessonTitle: string; score: number; subject: Subject }[]
): Promise<string> {
  return await callGemini('progress_report', { nickname, scores });
}

// ── Writing Feedback ──────────────────────────────────────────────────────────

/**
 * Reviews a student's short written answer for an ELA question.
 * Called by the sync engine in offline.ts — queued when offline, fired on reconnect.
 */
export async function getWritingFeedback(
  question:      string,
  studentAnswer: string,
  grade:         Grade
): Promise<string> {
  if (!navigator.onLine) {
    return "Offline! Your answer was saved — feedback coming when you reconnect. 📝";
  }

  return await callGemini('writing_feedback', { question, studentAnswer, grade });
}
