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
import { generateLesson, isPermanentFailure, isRateLimitFailure } from './gemini';
import { topicCount } from './topics';
import { withOfflineSupport } from '../utils/offline';
import type { Subject, Grade } from './types';

/**
 * What happened when a student asked for a new lesson.
 *
 * `queued` means the work is a durable row the sync engine will drain later —
 * the device was offline, or the call failed in a way retrying can fix.
 * `busy` means the proxy refused on quota grounds, which queueing would not
 * fix and which has nothing to do with being offline.
 */
export type GenerateOutcome = 'created' | 'queued' | 'exhausted' | 'busy';

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

  try {
    const lesson = await withOfflineSupport(
      async () => {
        const generated = await generateLesson(subject, grade, topicIndex, 'en');
        await saveLesson(generated);
        return generated;
      },
      async () => {
        await addToSyncQueue('generate_lesson', { subject, grade, topicIndex });
      },
      // Queue transient faults; refuse to queue anything the proxy already
      // rejected, since all three retries would be spent re-sending it.
      (err) => !isPermanentFailure(err)
    );

    return lesson ? 'created' : 'queued';
  } catch (err) {
    if (isRateLimitFailure(err)) return 'busy';
    // Any other 4xx means this build is sending a request the proxy does not
    // accept — a bug worth surfacing rather than swallowing.
    throw err;
  }
}
