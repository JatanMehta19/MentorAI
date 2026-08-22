// src/topics.ts
//
// The catalogue of topics a student can generate a lesson for.
//
// Shared deliberately: the browser uses it to know how many topics are left, and
// api/prompts.ts uses it to resolve an index back into a topic string. The client
// sends an *index*, never the topic text — so the only thing it can influence
// about a generated lesson prompt is which of these fixed strings gets used.
//
// Pure data with no DOM and no Node dependencies, so both the bundle and the edge
// function can import it.

import type { Subject, Grade } from './types';

const TOPICS: Record<Subject, Record<Grade, readonly string[]>> = {
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

/** How many topics exist for this subject and grade. */
export function topicCount(subject: Subject, grade: Grade): number {
  return TOPICS[subject][grade].length;
}

/**
 * Resolve a topic by index, or undefined when the index is out of range.
 *
 * Undefined is the "no topics left" signal and also the rejection path for a
 * caller that made up an index — the server treats both the same way.
 */
export function topicAt(subject: Subject, grade: Grade, index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  return TOPICS[subject][grade][index];
}
