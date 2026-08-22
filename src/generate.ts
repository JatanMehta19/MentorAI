// src/generate.ts
//
// On-demand lesson generation, triggered by the student rather than by boot.
//
// This used to be preload.ts: ten Gemini lessons generated automatically the
// first time a profile loaded. That put the network on the boot path — the one
// thing the app is supposed to never do — and on a public deployment it spent
// ten generations of quota per visitor, none of which they asked for. The ten
// bundled JSON lessons already make the app fully usable, so the AI work is now
// an explicit action.

import { addToSyncQueue, saveLesson, db } from './db';
import { generateLesson } from './gemini';
import { withOfflineSupport } from '../utils/offline';
import type { Subject, Grade } from './types';

// ── Topic Catalogue ───────────────────────────────────────────────────────────

/**
 * What a student can generate beyond the bundled lessons, per subject and grade.
 * A fixed list rather than a free-text field — an open topic box would hand the
 * student a writable slice of the prompt. The list moves server-side when the
 * proxy switches to an action-based API; until then this is the only thing
 * keeping arbitrary text out of it.
 */
const TOPICS: Record<Subject, Record<Grade, string[]>> = {
  math: {
    6: ['multiplying and dividing fractions', 'ratios and unit rates', 'negative numbers on a number line'],
    7: ['solving two-step equations', 'inequalities and number lines', 'proportional relationships'],
    8: ['the Pythagorean theorem', 'systems of equations', 'linear functions and slope'],
  },
  ela: {
    6: ['comparing and contrasting texts', 'context clues and vocabulary', 'identifying the main idea'],
    7: ['point of view and author purpose', 'text structure and organization', 'citing textual evidence'],
    8: ['evaluating evidence in arguments', 'analysing tone and mood', 'recognising bias in a source'],
  },
};

/**
 * What happened when a student asked for a new lesson.
 * `queued` covers both "offline" and "the call failed" — in each case the work
 * is now a durable row that the sync engine will drain later.
 */
export type GenerateOutcome = 'created' | 'queued' | 'exhausted';

/** How many topics remain ungenerated for this subject and grade. */
export async function remainingTopics(subject: Subject, grade: Grade): Promise<number> {
  return Math.max(0, TOPICS[subject][grade].length - (await generatedCount(subject, grade)));
}

/**
 * Generate the next unused topic for this subject and grade.
 *
 * Online, the lesson is fetched and saved immediately. Offline — or if the call
 * fails — the request becomes a `generate_lesson` row in the sync queue and the
 * student carries on. Nothing here blocks on the network.
 */
export async function generateNextLesson(
  subject: Subject,
  grade:   Grade
): Promise<GenerateOutcome> {
  const topics = TOPICS[subject][grade];
  const used   = await generatedCount(subject, grade);

  if (used >= topics.length) return 'exhausted';

  // Indexing by count rather than picking at random keeps repeat presses moving
  // down the list instead of regenerating a topic the student already has.
  const topic = topics[used]!;

  const lesson = await withOfflineSupport(
    async () => {
      const generated = await generateLesson(subject, grade, topic, 'en');
      await saveLesson(generated);
      return generated;
    },
    async () => {
      await addToSyncQueue('generate_lesson', { subject, grade, topic, language: 'en' });
    }
  );

  return lesson ? 'created' : 'queued';
}

// ── Private ───────────────────────────────────────────────────────────────────

/**
 * Count the AI-generated lessons already stored for this subject and grade.
 * Filtered in memory rather than indexed — the table holds tens of rows, and a
 * dedicated index would cost a schema migration for no measurable gain.
 */
async function generatedCount(subject: Subject, grade: Grade): Promise<number> {
  return db.lessons
    .filter(l => l.subject === subject && l.grade === grade && !l.isPreloaded)
    .count();
}
