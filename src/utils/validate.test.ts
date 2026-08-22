import { describe, it, expect } from 'vitest';
import { isValidQuestion, isValidLessonResponse, asFreshQuestion, parseJsonLoosely } from './validate';

/** A question that should pass, which each case then breaks in exactly one way. */
function validQuestion(): Record<string, unknown> {
  return {
    prompt:       'What is 1/2 + 1/4?',
    choices:      ['1/4', '2/6', '3/4', '1'],
    correctIndex: 2,
    hint:         'Give both fractions the same denominator first.',
    answered:     false,
    correct:      false,
    difficulty:   1,
  };
}

describe('isValidQuestion', () => {

  it('accepts a well-formed question', () => {
    expect(isValidQuestion(validQuestion())).toBe(true);
  });

  it.each([
    ['correctIndex past the end',   { correctIndex: 7 }],
    ['negative correctIndex',       { correctIndex: -1 }],
    ['correctIndex as a string',    { correctIndex: '2' }],
    ['fractional correctIndex',     { correctIndex: 1.5 }],
    ['NaN correctIndex',            { correctIndex: NaN }],
    ['correctIndex exactly at len', { correctIndex: 4 }],
  ])('rejects %s', (_label, override) => {
    expect(isValidQuestion({ ...validQuestion(), ...override })).toBe(false);
  });

  it('rejects three choices', () => {
    expect(isValidQuestion({ ...validQuestion(), choices: ['a', 'b', 'c'], correctIndex: 1 })).toBe(false);
  });

  it('rejects five choices', () => {
    expect(isValidQuestion({ ...validQuestion(), choices: ['a', 'b', 'c', 'd', 'e'] })).toBe(false);
  });

  it('rejects a blank choice', () => {
    expect(isValidQuestion({ ...validQuestion(), choices: ['a', '   ', 'c', 'd'] })).toBe(false);
  });

  it('rejects a non-string choice', () => {
    expect(isValidQuestion({ ...validQuestion(), choices: ['a', 'b', 'c', 4] })).toBe(false);
  });

  it('rejects an empty prompt', () => {
    expect(isValidQuestion({ ...validQuestion(), prompt: '  ' })).toBe(false);
  });

  it('rejects a missing hint', () => {
    const q = validQuestion();
    delete q.hint;
    expect(isValidQuestion(q)).toBe(false);
  });

  it('rejects an out-of-range difficulty', () => {
    expect(isValidQuestion({ ...validQuestion(), difficulty: 9 })).toBe(false);
  });

  it.each([null, undefined, 'a string', 42, [], [validQuestion()]])(
    'rejects the non-object %p', (v) => {
      expect(isValidQuestion(v)).toBe(false);
    });

  it('accepts a question missing the progress flags', () => {
    // answered/correct are local state, not content — asFreshQuestion sets them.
    const q = validQuestion();
    delete q.answered;
    delete q.correct;
    expect(isValidQuestion(q)).toBe(true);
  });
});

describe('isValidLessonResponse', () => {

  const validLesson = () => ({
    title:     'Adding Fractions',
    content:   'Fractions add when their denominators match.',
    questions: [validQuestion(), validQuestion()],
  });

  it('accepts a well-formed lesson', () => {
    expect(isValidLessonResponse(validLesson())).toBe(true);
  });

  it('rejects a lesson with no questions', () => {
    expect(isValidLessonResponse({ ...validLesson(), questions: [] })).toBe(false);
  });

  it('rejects a lesson when a single question is bad', () => {
    // One poisoned question fails the whole lesson: a half-usable lesson would
    // still put an unanswerable question in front of a student.
    const lesson = validLesson();
    lesson.questions[1] = { ...validQuestion(), correctIndex: 99 };
    expect(isValidLessonResponse(lesson)).toBe(false);
  });

  it('rejects a lesson with an empty title', () => {
    expect(isValidLessonResponse({ ...validLesson(), title: '' })).toBe(false);
  });

  it('rejects questions that is not an array', () => {
    expect(isValidLessonResponse({ ...validLesson(), questions: 'five of them' })).toBe(false);
  });
});

describe('asFreshQuestion', () => {

  it('forces the progress flags to false', () => {
    // A model returning answered:true would hand the student a question the app
    // believes they already finished.
    const q = { ...validQuestion(), answered: true, correct: true } as never;
    const fresh = asFreshQuestion(q);
    expect(fresh.answered).toBe(false);
    expect(fresh.correct).toBe(false);
  });

  it('leaves the content alone', () => {
    const fresh = asFreshQuestion(validQuestion() as never);
    expect(fresh.prompt).toBe('What is 1/2 + 1/4?');
    expect(fresh.correctIndex).toBe(2);
  });
});

describe('parseJsonLoosely', () => {

  it('parses plain JSON', () => {
    expect(parseJsonLoosely('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips the code fences models add despite being told not to', () => {
    expect(parseJsonLoosely('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('returns undefined rather than throwing on prose', () => {
    // The sync queue reads a throw as "retry"; parsing has to fail quietly so
    // the caller decides what a malformed response means.
    expect(parseJsonLoosely('Sure! Here is your lesson:')).toBeUndefined();
  });

  it('returns undefined on truncated JSON', () => {
    expect(parseJsonLoosely('{"title":"Frac')).toBeUndefined();
  });
});
