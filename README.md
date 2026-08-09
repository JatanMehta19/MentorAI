# MentorAI

An offline-first web tutor for grades 6–8, covering math and ELA. Students work through
lessons, quizzes, and timed "boss battles" with no network connection — all content and
progress live in the browser's IndexedDB. When a connection is available, Gemini generates
additional lessons and answers tutor questions.

Built at a 48-hour hackathon in April 2026 by a team of four, and continued since as a
solo project.

<!-- Demo GIF goes here once recorded -->

## Why it's built this way

The target device is a cheap Android phone — roughly 2018-era, 2GB of RAM, on an
intermittent connection or none at all. That constraint drove most of the technical
decisions, and it's worth stating up front because several of them look like omissions
otherwise:

- **No UI framework.** The app is vanilla TypeScript with direct DOM manipulation. On this
  hardware, framework parse-and-execute time costs more than the download does. React or
  Vue would have been faster to write and slower to run.
- **Network is never on the critical path.** Every student action — answering a question,
  finishing a lesson, earning XP — completes against local storage. Nothing blocks on a
  request.
- **TypeScript in strict mode**, because types compile away and cost nothing at runtime.

The production bundle is 45.9 kB gzipped of JavaScript and 5.9 kB gzipped of CSS, plus ten
lazily-loaded lesson chunks of roughly 0.6 kB each.

## Stack

| | |
|---|---|
| Language | TypeScript (strict) |
| UI | Vanilla DOM, no framework |
| Storage | IndexedDB via [Dexie](https://dexie.org/) 4 |
| Build | Vite 5 |
| Offline | `vite-plugin-pwa` (Workbox), 17 precached entries |
| AI | Google Gemini 2.0 Flash |

## Running it

Requires Node 18 or newer.

```bash
npm install
npm run dev
```

To build and preview the production output:

```bash
npm run build
npm run preview
```

### Gemini API key

The key is held server-side and never reaches the browser. Copy `.env.example` to `.env` in
the project root:

```
GEMINI_API_KEY=your_key_here
```

The name deliberately has no `VITE_` prefix. Vite inlines every `import.meta.env.VITE_*`
value into the public bundle at build time, so a `VITE_`-prefixed key would be readable by
anyone who opens devtools. This one is read only in Node — by the serverless function in
`api/gemini.ts` in production, and by a small dev middleware in `vite.config.ts` locally, so
`npm run dev` and `npm run preview` both work without extra tooling. The browser only ever
talks to a same-origin `/api/gemini`.

When deploying, set `GEMINI_API_KEY` in your host's environment variables, not in the repo.

**The app runs fine without one.** The ten bundled lessons are seeded into IndexedDB
independently of Gemini, so the entire lesson, quiz, and boss-battle flow works. Only the
tutor chat and AI lesson generation degrade — the tutor returns a connection-error message
and lesson preloading is skipped.

## Architecture: the offline sync engine

The piece of this project worth reading is [`utils/offline.ts`](utils/offline.ts).

The problem it solves: a student answers a question correctly, which should trigger a
Gemini call to generate a harder replacement question. But the student is on a bus with no
signal. The answer must still be recorded, XP must still be awarded, and the Gemini work
has to happen later without the student ever waiting on it.

The approach is a durable job queue in IndexedDB rather than in-memory retries. In-memory
retries die with the tab, and on a phone the tab is killed constantly — backgrounded,
low-memory, browser restarted. Writing the intent to disk first means a queued job survives
all of that.

```
student action ──▶ IndexedDB write (immediate, always succeeds)
                        │
                        └──▶ syncQueue row ──▶ drain on reconnect ──▶ Gemini
```

**The queue.** A Dexie table (`syncQueue`) where each row is a `SyncQueueItem`:

```ts
{ id, type, payload, timestamp, retries }
```

`type` is one of four jobs — `replace_question`, `generate_lesson`, `progress_report`,
`get_feedback` — which `processSyncItem` routes to the matching Gemini call. Items drain
oldest-first by `timestamp`.

**Drain triggers.** Three, deliberately different:

| Trigger | Timing | Why |
|---|---|---|
| `online` event | debounced 1500 ms | Reconnects flap. Debouncing avoids firing into a connection that's still settling. |
| `visibilitychange` | immediate | The tab was backgrounded and is now foregrounded; the network is likely already stable. |
| App startup | immediate | Catches jobs queued in a previous session that never drained. |

**Concurrency.** A `syncInProgress` flag guards re-entry, so overlapping triggers can't
start two drains against the same rows. Items are processed serially, not in parallel —
on the target hardware, and against a rate-limited API, sequential is the right default.

**Failure handling.** A failed job increments `retries` and pauses 2000 ms before the next
item. At `MAX_RETRIES` (3) the job is dropped so one poisoned row can't block the queue
forever. If the connection drops mid-drain, the loop breaks and leaves the remaining rows
for the next trigger.

**`withOfflineSupport`** wraps a call so it runs immediately when online and enqueues a
fallback when not, which keeps the branching out of the calling code.

## Current limitations

This section is deliberately specific. Nothing below is fixed yet.

- **The boss battle does not feed the sync engine.** The quiz path records every answer via
  `markQuestionAnswered`, but `startBossBattle` builds its question pool with
  `flatMap(l => l.questions)` and discards the lesson id, so boss answers cannot be attributed
  to a lesson. Wiring it needs `BossState` to carry `{ lessonId, questionIndex }`.
- **The proxy forwards an arbitrary prompt.** `api/gemini.ts` keeps the key server-side and
  rejects cross-origin callers, but it still relays whatever prompt it is given. Origin headers
  are trivially forged outside a browser, so the endpoint could be used as a general-purpose
  Gemini relay against the deployment's quota. The fix is an action-based API
  (`{ action, params }`) that builds prompts server-side. There is no rate limiting.
- **Model output is still parsed loosely.** The response envelope is now guarded and requests
  time out after 15s, but `JSON.parse` still runs on model output after only stripping code
  fences, prompts ask for JSON instead of using Gemini's `responseSchema` structured output,
  and there's no retry on 429 or 503.
- **Generated answers are unverified.** Nothing checks that a generated question's
  `correctIndex` is actually correct, or even in range, before showing it to a student.
- **The progress view is device-local.** `src/screens/teacher.ts` reads the same browser's
  IndexedDB, so it can only ever show the student sitting at that device. It is not a
  teacher dashboard, and it isn't currently reachable from the UI.
- **User input is not escaped consistently.** Screens build HTML with template strings and
  `innerHTML`. An `escapeHtml` helper exists but is applied at only a few of those sites;
  the student nickname reaches the DOM unescaped.
- **No URL routing.** Navigation is held in module-level state, so a page refresh returns to
  the onboarding screen and no view is linkable.
- **No tests.** The sync engine needs them most.

## Project history

Built April 25–26, 2026 at a 48-hour hackathon by a team of four. The state at submission is
tagged [`v0.1-hackathon`](https://github.com/JatanMehta19/MentorAI/releases/tag/v0.1-hackathon).
Everything after that tag is solo follow-on work.
