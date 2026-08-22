// src/utils/validate.ts
//
// Runtime guards for model output.
//
// gemini.ts used to do `JSON.parse(cleaned) as Question` — a cast, which is a
// promise to the compiler, not a check on the value. Gemini is asked for a shape
// in the prompt; it is not obliged to return one. Anything that gets this wrong
// reaches a student: an out-of-range correctIndex produces a question that cannot
// be answered correctly, and the grading code then queries a `[data-choice="N"]`
// button that does not exist.
//
// Hand-written rather than zod. Zod is ~13 kB gzipped against a 47 kB bundle on a
// device chosen for being slow, and the whole schema is two shapes.

import type { Question, GeminiLessonResponse } from '../types';

// ── Primitives ────────────────────────────────────────────────────────────────

const CHOICE_COUNT = 4;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── Guards ────────────────────────────────────────────────────────────────────

/**
 * True when `v` is a Question that can actually be presented and graded.
 *
 * `correctIndex` is checked against the real length of `choices`, not against a
 * hardcoded 0–3, so the two can never disagree.
 *
 * `answered` and `correct` are deliberately not required. The prompt asks for
 * them, but they are local progress flags rather than content — normalise them
 * instead of rejecting an otherwise good question over them.
 */
export function isValidQuestion(v: unknown): v is Question {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.prompt)) return false;
  if (!isNonEmptyString(v.hint)) return false;

  if (!Array.isArray(v.choices)) return false;
  if (v.choices.length !== CHOICE_COUNT) return false;
  if (!v.choices.every(isNonEmptyString)) return false;

  // Number.isInteger rejects 1.5, NaN, Infinity and the string "0" in one call.
  if (!Number.isInteger(v.correctIndex)) return false;
  const index = v.correctIndex as number;
  if (index < 0 || index >= v.choices.length) return false;

  if (v.difficulty !== 1 && v.difficulty !== 2 && v.difficulty !== 3) return false;

  return true;
}

/** True when `v` is a lesson body with at least one usable question. */
export function isValidLessonResponse(v: unknown): v is GeminiLessonResponse {
  if (!isRecord(v)) return false;
  if (!isNonEmptyString(v.title)) return false;
  if (!isNonEmptyString(v.content)) return false;
  if (!Array.isArray(v.questions) || v.questions.length === 0) return false;
  return v.questions.every(isValidQuestion);
}

// ── Normalisation ─────────────────────────────────────────────────────────────

/**
 * Force the two progress flags to false on a freshly generated question.
 *
 * A model that returns `answered: true` would otherwise hand the student a
 * question the app believes they have already completed.
 */
export function asFreshQuestion(question: Question): Question {
  return { ...question, answered: false, correct: false };
}

// ── Parsing ───────────────────────────────────────────────────────────────────

/**
 * Parse a model response that is supposed to be JSON.
 *
 * Strips the code fences models add despite being told not to, then parses.
 * Returns undefined rather than throwing so the caller decides what a malformed
 * response means — for the sync queue it means "retry", not "crash".
 */
export function parseJsonLoosely(raw: string): unknown {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}
