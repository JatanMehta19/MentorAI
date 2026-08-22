// src/gemini.ts
import type { Lesson, GeminiLessonResponse, Subject, Grade, Language, Question } from './types';

// The API key lives server-side in api/gemini.ts and is never shipped to the
// browser. Anything read via import.meta.env.VITE_* is inlined into the public
// bundle at build time, so the key must never come back here.
const PROXY_URL  = '/api/gemini';
// Deliberately longer than the proxy's own 30s upstream timeout. When the two
// were both 15s they raced, and the client usually won — turning a clean 504
// from the proxy into an opaque AbortError with nothing to report. Let the
// server time out first; this is only a backstop for a hung proxy.
const TIMEOUT_MS = 35000;

// ── Core Fetch ────────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  // The sync queue drains serially, so one hung request would stall every
  // item behind it.
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt }),
      signal:  controller.signal,
    });

    const data = await res.json().catch(() => null) as
      { text?: string; error?: string } | null;

    if (!res.ok) {
      throw new Error(data?.error ?? `Gemini proxy error: ${res.status}`);
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
 * Ask Gemini to generate a full lesson for a given topic.
 * Returns a Lesson object ready to be saved via saveLesson() or bulkSaveLessons().
 */
export async function generateLesson(
  subject:  Subject,
  grade:    Grade,
  topic:    string,
  language: Language
): Promise<Omit<Lesson, 'id'>> {

  const prompt = `
    You are creating educational content for a grade ${grade} student.
    Subject: ${subject === 'ela' ? 'English Language Arts' : 'Math'}
    Topic: "${topic}"
    Language: English

    Respond ONLY with valid JSON in exactly this shape — no explanation, no markdown:
    {
      "title": "short lesson title",
      "content": "2-3 paragraphs of lesson explanation, age-appropriate for grade ${grade}",
      "questions": [
        {
          "prompt": "question text",
          "choices": ["option A", "option B", "option C", "option D"],
          "correctIndex": 0,
          "hint": "one sentence hint",
          "answered": false,
          "correct": false,
          "difficulty": 1
        }
      ]
    }

    Rules:
    - Write exactly 5 questions
    - Every question MUST include answered: false, correct: false, difficulty: 1
    - Keep language simple and engaging for middle school
    - correctIndex must be 0, 1, 2, or 3
    - Do not include any text outside the JSON object
  `;

  const raw     = await callGemini(prompt);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed  = JSON.parse(cleaned) as GeminiLessonResponse;

  return {
    subject,
    grade,
    language,
    title:       parsed.title,
    content:     parsed.content,
    questions:   parsed.questions,
    createdAt:   new Date().toISOString(),
    isPreloaded: false,
  };
}

// ── Question Replacement ────────────────────────────────────────────────────────

/**
 * Ask Gemini to generate a single harder replacement question for a lesson.
 * Only called when a student answers a question correctly.
 */
export async function replaceQuestion(
  subject:  Subject,
  grade:    Grade,
  topic:    string,
  currentDifficulty: 1 | 2 | 3
): Promise<Question> {
  const nextDifficulty = Math.min(currentDifficulty + 1, 3) as 1 | 2 | 3;

  const prompt = `
    You are creating a grade ${grade} ${subject === 'ela' ? 'English Language Arts' : 'Math'} question.
    Topic: "${topic}"
    Current difficulty: ${currentDifficulty}
    New difficulty level: ${nextDifficulty} (1=easy, 2=medium, 3=hard)

    Respond ONLY with valid JSON in exactly this shape — no explanation, no markdown:
    {
      "prompt": "question text",
      "choices": ["option A", "option B", "option C", "option D"],
      "correctIndex": 0,
      "hint": "one sentence hint",
      "answered": false,
      "correct": false,
      "difficulty": ${nextDifficulty}
    }

    Rules:
    - Make this harder than difficulty ${currentDifficulty} but still solvable for grade ${grade}
    - Keep language appropriate for middle school students
    - correctIndex must be 0, 1, 2, or 3
    - Do NOT include any text outside the JSON object
  `;

  const raw     = await callGemini(prompt);
  const cleaned = raw.replace(/```json|```/g, '').trim();
  const parsed  = JSON.parse(cleaned) as Question;

  return parsed;
}

/**
 * Get a tutor response for a student's live question.
 * Called by Person 2's lesson screen chat box.
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

  const prompt = `
    You are MentorAI, a helpful and encouraging tutor for a grade ${grade} student.
    Current lesson context: ${lessonContext}
    Student question: "${studentQuestion}"

    Rules:
    - Answer in 2-3 short sentences max
    - Use simple, clear language appropriate for grade ${grade}
    - Be encouraging and direct — like a smart older sibling, not a textbook
    - End with one actionable tip or follow-up thought
  `;

  return await callGemini(prompt);
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
  const scoreList = scores
    .map(s => `- ${s.lessonTitle} (${s.subject}): ${s.score}%`)
    .join('\n');

  const prompt = `
    Write a short teacher progress report (3-4 sentences) for a student nicknamed "${nickname}".

    Recent quiz scores:
    ${scoreList}

    Rules:
    - Highlight one specific strength based on the scores
    - Identify one specific area to improve
    - Suggest one concrete activity or focus for next session
    - Write in a warm, professional tone like a real teacher's note
    - Do NOT use the word "student" — use "${nickname}" instead
    - Keep it under 80 words
  `;

  return await callGemini(prompt);
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

  const prompt = `
    You are reviewing a grade ${grade} student's written answer.
    Question: "${question}"
    Student's answer: "${studentAnswer}"

    Give exactly 2 pieces of feedback:
    1. One specific thing they did well
    2. One specific thing to improve

    Keep each point to one sentence. Be encouraging and specific.
  `;

  return await callGemini(prompt);
}