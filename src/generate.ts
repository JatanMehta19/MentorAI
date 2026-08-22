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

import { addToSyncQueue, saveLesson, countGeneratedLessons } from './db';
import { generateLesson } from './gemini';
import { topicCount } from './topics';
import { withOfflineSupport } from '../utils/offline';
import type { Subject, Grade } from './types';

/**
 * What happened when a student asked for a new lesson.
 * `queued` covers both "offline" and "the call failed" — in each case the work
 * is now a durable row that the sync engine will drain later.
 */
export type GenerateOutcome = 'created' | 'queued' | 'exhausted';

/** How many topics remain ungenerated for this subject and grade. */
export async function remainingTopics(subject: Subject, grade: Grade): Promise<number> {
  return Math.max(0, topicCount(subject, grade) - (await countGeneratedLessons(subject, grade)));
}

/**
 * Generate the next unused topic for this subject and grade.
 *
 * Online, the lesson is fetched and saved immediately. Offline — or if the call
 * fails — the request becomes a `generate_lesson` row in the sync queue and the
 * student carries on. Nothing here blocks on the network.
 *
 * The topic is passed as an index into the catalogue in topics.ts, never as
 * text. The proxy resolves it against its own copy of the same list, so this
 * path cannot be used to put arbitrary words into a prompt.
 */
export async function generateNextLesson(
  subject: Subject,
  grade:   Grade
): Promise<GenerateOutcome> {
  // Counting by index rather than picking at random keeps repeat presses moving
  // down the list instead of regenerating a topic the student already has.
  const topicIndex = await countGeneratedLessons(subject, grade);

  if (topicIndex >= topicCount(subject, grade)) return 'exhausted';

  const lesson = await withOfflineSupport(
    async () => {
      const generated = await generateLesson(subject, grade, topicIndex, 'en');
      await saveLesson(generated);
      return generated;
    },
    async () => {
      await addToSyncQueue('generate_lesson', { subject, grade, topicIndex });
    }
  );

  return lesson ? 'created' : 'queued';
}
