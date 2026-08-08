// db.ts
// Local IndexedDB database using Dexie.js.
// All data lives on the student's device — no server, fully offline.
// Import query functions from here instead of touching `db` directly.

import Dexie, { type EntityTable } from 'dexie';
import type { Lesson, Question, Progress, StudentProfile, SyncQueueItem, Subject, Grade, Language } from './types';

// ── Database Setup ────────────────────────────────────────────────────────────

// Create the Dexie instance typed with our four tables.
// EntityTable<T, 'id'> tells Dexie that 'id' is the primary key for each table.
const db = new Dexie('MentorAIDB') as Dexie & {
  lessons:        EntityTable<Lesson,         'id'>;
  progress:       EntityTable<Progress,       'id'>;
  studentProfile: EntityTable<StudentProfile, 'id'>;
  syncQueue:      EntityTable<SyncQueueItem,  'id'>;
};

// Schema definition — only fields listed here are searchable/filterable.
// '++id' means auto-increment primary key (never set manually).
// Other listed fields become indexes so .where() queries work on them.
db.version(1).stores({
  lessons:        '++id, subject, grade, language, isPreloaded',
  progress:       '++id, nickname, lessonId, subject, completedAt',
  studentProfile: '++id, nickname',
  syncQueue:      '++id, type, timestamp',
});

export { db };

// ── Lessons ───────────────────────────────────────────────────────────────────

/**
 * Load all pre-written lesson JSON files into IndexedDB on first launch.
 * Uses Vite's import.meta.glob to bundle all files in /lessons/ at build time.
 * Safe to call on every launch — bails out early if already seeded.
 */
export async function seedLessons(): Promise<void> {
  const alreadySeeded = await hasPreloadedLessons();
  if (alreadySeeded) return;

  // Vite resolves this glob at build time — all JSON files are bundled into the app
  const modules = import.meta.glob('../lessons/*.json');

  for (const path in modules) {
    const data = await modules[path]() as { default: Omit<Lesson, 'id'> };
    await db.lessons.add({
      ...data.default,
      createdAt:   new Date().toISOString(),
      isPreloaded: true,
    } as Lesson);
  }
}

/**
 * Fetch all lessons matching a specific grade, subject, and language.
 * Used by Person 2's lesson screen to load available content offline.
 */
export async function getLessons(
  grade: Grade,
  subject: Subject,
  language: Language
): Promise<Lesson[]> {
  return db.lessons.where({ grade, subject, language }).toArray();
}

/**
 * Fetch every lesson for a grade, across all subjects.
 * The dashboard counts math and ELA side by side, so it needs both at once.
 * Screens that show a single subject filter this list themselves.
 */
export async function getLessonsForGrade(
  grade: Grade,
  language: Language
): Promise<Lesson[]> {
  return db.lessons.where({ grade, language }).toArray();
}

/**
 * Save a single Gemini-generated lesson to the local database.
 * Returns the auto-assigned numeric id of the new record.
 */
export async function saveLesson(lesson: Omit<Lesson, 'id'>): Promise<number> {
  const id = await db.lessons.add(lesson as Lesson);
  return id!;
}

/**
 * Replace a specific question in a lesson with a new one.
 * Called by the sync engine after Gemini generates a replacement.
 */
export async function replaceQuestionInLesson(
  lessonId:      number,
  questionIndex: number,
  newQuestion:  Question
): Promise<void> {
  const lesson = await db.lessons.get(lessonId);
  if (!lesson) return;

  lesson.questions[questionIndex] = newQuestion;
  await db.lessons.update(lessonId, { questions: lesson.questions });
}

/**
 * Save multiple lessons at once — used on first launch to bulk-load
 * all pre-written lesson JSON files into the database in one operation.
 */
export async function bulkSaveLessons(lessons: Omit<Lesson, 'id'>[]): Promise<void> {
  await db.lessons.bulkAdd(lessons as Lesson[]);
}

/**
 * Returns true if pre-written lessons have already been loaded.
 * Called on startup to avoid re-inserting the same lessons every time.
 */
export async function hasPreloadedLessons(): Promise<boolean> {
  const count = await db.lessons.filter(l => l.isPreloaded === true).count();
  return count > 0;
}

// ── Progress ──────────────────────────────────────────────────────────────────

/**
 * Mark a single question in a lesson as answered.
 * Called after every answer in the quiz engine.
 * Works 100% offline — writes directly to IndexedDB.
 *
 * Idempotent per question. Retaking a quiz re-answers questions that are already
 * correct, so queueing is gated on the answer actually transitioning to correct.
 * Without that gate a retake re-queues a replacement for every question, and
 * re-fires generate_lesson on every single answer once a lesson is fully aced.
 */
export async function markQuestionAnswered(
  lessonId:      number,
  questionIndex: number,
  isCorrect:     boolean
): Promise<void> {
  const lesson = await db.lessons.get(lessonId);
  if (!lesson) return;

  const currentQ = lesson.questions[questionIndex];
  if (!currentQ) return;

  // Capture before mutating — this is what tells a real transition from a repeat click
  const wasAlreadyCorrect = currentQ.answered === true && currentQ.correct === true;

  // Update the specific question in the array
  currentQ.answered = true;
  currentQ.correct  = isCorrect;

  await db.lessons.update(lessonId, { questions: lesson.questions });

  // Nothing further to queue if this question was already correct — the lesson
  // state is unchanged, so any queue item it would produce is already pending.
  if (wasAlreadyCorrect) return;

  // Queue Gemini replacement if answered correctly and not at max difficulty
  if (isCorrect && currentQ.difficulty < 3) {
    await addToSyncQueue('replace_question', {
      lessonId:      lessonId,
      questionIndex: questionIndex,
      subject:      lesson.subject,
      grade:        lesson.grade,
      topic:       lesson.title,
      difficulty:  currentQ.difficulty,
    });
  }

  // Auto-queue entire new lesson the moment the student aces the whole lesson
  const allCorrect = lesson.questions.every(q => q.answered && q.correct);
  if (allCorrect) {
    await addToSyncQueue('generate_lesson', {
      subject:  lesson.subject,
      grade:    lesson.grade,
      language: lesson.language,
      topic:    lesson.title,
    });
  }
}

/**
 * Save a completed quiz attempt.
 * Called by Person 3's quiz engine immediately after the student finishes.
 * Works 100% offline — data stays local until sync runs.
 */
export async function saveProgress(progress: Omit<Progress, 'id'>): Promise<number> {
  const id = await db.progress.add(progress as Progress);
  return id!;
}

/**
 * Get all quiz attempts for a student, newest first.
 * Used by Person 3's teacher dashboard to show recent activity.
 */
export async function getProgressForStudent(nickname: string): Promise<Progress[]> {
  return db.progress.where('nickname').equals(nickname).reverse().toArray();
}

/**
 * Get quiz attempts for a student filtered by subject (math or ela).
 * Used to show per-subject performance breakdowns on the dashboard.
 */
export async function getProgressBySubject(
  nickname: string,
  subject: Subject
): Promise<Progress[]> {
  return db.progress
    .where('nickname').equals(nickname)
    .filter(p => p.subject === subject)
    .toArray();
}

// ── Student Profile ───────────────────────────────────────────────────────────

/**
 * Load a student's profile by nickname.
 * Returns undefined if no profile exists yet (first launch).
 */
export async function getProfile(nickname: string): Promise<StudentProfile | undefined> {
  return db.studentProfile.where('nickname').equals(nickname).first();
}

/**
 * Create a brand new student profile on first launch.
 * Called after the student picks their nickname and grade.
 */
export async function createProfile(
  profile: Omit<StudentProfile, 'id'>
): Promise<number> {
  const id = await db.studentProfile.add(profile as StudentProfile);
  return id!;
}

/**
 * Update specific fields on a student's profile.
 * Person 3 calls this after every quiz to update XP, level, and streak.
 * Pass only the fields you want to change — other fields stay untouched.
 *
 * Example: updateProfile('StarCoder99', { totalXP: 450, currentLevel: 3 })
 */
// FIXED — level is calculated and saved
export async function updateProfile(
  nickname: string,
  updates: Partial<StudentProfile>
): Promise<void> {
  const profile = await getProfile(nickname);
  if (!profile) return;

  const newXP = updates.totalXP ?? profile.totalXP;
  const newLevel = calculateLevel(newXP);

  await db.studentProfile.update(profile.id as number, {
    ...updates,
    currentLevel: newLevel,
  });
}
export function calculateLevel(xp: number): number {
  if (xp >= 1000) return 5;
  if (xp >= 700) return 4;
  if (xp >= 450) return 3;
  if (xp >= 250) return 2;
  return 1;
}

export function calculateStreak(lastActive: string, currentStreak: number): number {
  const last = new Date(lastActive);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return currentStreak;
  if (diffDays === 1) return currentStreak + 1;
  return 1;
}

// ── Sync Queue ────────────────────────────────────────────────────────────────

/**
 * Add a Gemini API call to the queue when the device is offline.
 * The sync engine in utils/offline.ts will process this when WiFi returns.
 *
 * Example: addToSyncQueue('generate_lesson', { subject: 'math', grade: 7, ... })
 */
export async function addToSyncQueue(
  type: SyncQueueItem['type'],
  payload: Record<string, unknown>
): Promise<void> {
  await db.syncQueue.add({ type, payload, timestamp: Date.now(), retries: 0 } as SyncQueueItem);
}

/**
 * Get all unprocessed sync items, oldest first.
 * Called by utils/offline.ts when the device comes back online.
 */
export async function getPendingSyncItems(): Promise<SyncQueueItem[]> {
  return db.syncQueue.orderBy('timestamp').toArray();
}

/**
 * Remove a sync item after it has been successfully processed.
 * Called by the sync engine in utils/offline.ts after each successful Gemini call.
 */
export async function clearSyncItem(id: number): Promise<void> {
  await db.syncQueue.delete(id);
}

/**
 * Increment the retry count on a failed sync item.
 * The sync engine skips items that have failed 3+ times to avoid infinite loops.
 */
export async function incrementSyncRetry(id: number): Promise<void> {
  const item = await db.syncQueue.get(id);
  if (!item) return;
  await db.syncQueue.update(item.id as number, { retries: (item.retries ?? 0) + 1 });
}

/**
 * Wipe the entire sync queue.
 * Only used after a successful full sync where everything was processed.
 */
export async function clearAllSyncItems(): Promise<void> {
  await db.syncQueue.clear();
}

export default db;