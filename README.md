# MentorAI

[![CI](https://github.com/JatanMehta19/MentorAI/actions/workflows/ci.yml/badge.svg)](https://github.com/JatanMehta19/MentorAI/actions/workflows/ci.yml)

**Live: https://mentor-ai-bice.vercel.app**

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

The production bundle is 47.4 kB gzipped of JavaScript and 6.5 kB gzipped of CSS, plus ten
lazily-loaded lesson chunks of roughly 0.6 kB each.

## Stack

| | |
|---|---|
| Language | TypeScript (strict) |
| UI | Vanilla DOM, no framework |
| Storage | IndexedDB via [Dexie](https://dexie.org/) 4 |
| Build | Vite 5 |
| Offline | `vite-plugin-pwa` (Workbox), 21 precached entries |
| AI | Google Gemini 3.6 Flash, behind a server-side proxy |

Dexie is the only runtime dependency. Everything else — routing, rendering, state,
animation, icons — is hand-written or CSS.

## Running it

Requires Node 20 or newer. CI runs the suite on 20 and 24.

```bash
npm install
npm run dev
```

To build and preview the production output:

```bash
npm run build
npm run preview
```

To run the test suite:

```bash
npm test
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
tutor chat and the "Generate a new lesson" button need a key — without one the tutor
returns a connection message and a generate request lands in the sync queue, where it
retries and is eventually dropped.

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

**Timeouts, measured — and re-measured after the first answer turned out to be wrong.**

Generating a five-question lesson with `gemini-3.6-flash` took 10.8s, 12.5s, 21.3s, 41.1s
and 51.8s across five runs. Both the client and the proxy were originally capped at 15s, so
the tail was cut off — and because both used the *same* 15s they raced, with the client
usually winning and turning the proxy's clean 504 into an opaque `AbortError`. Raising the
proxy to 30s and the client to 35s fixed the race.

It did not fix generation, and deploying proved why. `generate_lesson` came back as
`504 FUNCTION_INVOCATION_TIMEOUT` at 25.1s: **Vercel caps a Hobby Edge function at 25s**, so
a 30s abort could never fire. The platform killed the invocation first and answered with a
`text/plain` error page — neither the function's own JSON nor a status the client could
classify. Switching runtime buys nothing; Node functions on Hobby cap at 10s, so Edge is the
widest window available rather than a compromise.

Two changes, in order of certainty:

- **The proxy aborts at 22s and the client waits 27s.** 22s fires ~3s inside the platform
  ceiling, so the decision stays in application code and the caller gets structured JSON.
- **Generated lessons ask for three questions, not five**, and a shorter body. Output tokens
  are the dominant latency term. Constraining the model's thinking was tried first and
  measured *worse* (`thinkingLevel: "low"` at 41.1s against a 21.3s baseline) — two samples
  against a noisy distribution, so it proved nothing and was dropped.

| | 5 questions | 3 questions |
|---|---|---|
| samples | 10.8, 12.5, 21.3, 41.1, 51.8s | 8.5, 9.5, 11.5, 14.2, 16.0s |
| median | 21.3s | 11.5s |
| worst | 51.8s | 16.0s |
| inside the 22s abort | ~2/5 | 5/5 |

The ten bundled JSON lessons still carry five questions; this only shapes what the model is
asked to write. Anything still too slow is left to the queue, and because the latency varies
this much, a retry genuinely resamples rather than repeating a doomed call.

**`withOfflineSupport`** wraps a call so it runs immediately when online and enqueues a
fallback when not, which keeps the branching out of the calling code. Its caller is the
"Generate a new lesson" button on each subject page: pressing it online writes the lesson
immediately, and pressing it with no connection — or with the proxy unreachable — turns
the request into a queued row and tells the student so. That is the whole engine in one
button, which is also what makes it demonstrable.

This replaced a `preload.ts` that generated ten lessons automatically on first boot. That
put the network on the boot path, and on a public deployment it spent ten generations of
quota per visitor who never asked for any of them.

**Visible state.** A dot in the top-right corner is green online, red offline, and pulses gold
while the queue drains. It is mounted on `<body>` rather than the app root, because navigation
replaces the root's `innerHTML` wholesale and would otherwise destroy it mid-drain.

**Tests.** [`utils/offline.test.ts`](utils/offline.test.ts) covers the queue's control flow —
work held offline and flushed on reconnect, a flapping connection debounced into one drain,
overlapping drains processing each item once, retry counting, the `MAX_RETRIES` give-up, a
connection lost mid-drain leaving the rest queued, and a throwing UI listener not stranding the
queue. The Gemini layer is mocked; Dexie runs for real against `fake-indexeddb`, so retry
counters are asserted against actual IndexedDB rows.

## Offline, and how it's verified

One service worker, generated by `vite-plugin-pwa` in `autoUpdate` mode. A second
hand-written `public/sw.js` used to ship alongside it — nothing registered it, and Workbox
emitted to the same `dist/sw.js` path, so it was silently overwritten at build time. It's
gone, along with the duplicate `public/manifest.json` that was being precached for nothing.

`/api/gemini` is on the Workbox `navigateFallbackDenylist`. The proxy is a live network
call and must never be answered from cache.

The claim is tested by killing the server outright rather than by throttling devtools:

```bash
npm run build && npm run preview   # load once, then stop the server
```

With nothing listening on the port, a hard reload still serves `index.html`, the JS and CSS
bundles, every lazily-loaded lesson chunk, the manifest and the icons — all from the
service worker — and onboarding through to the dashboard works against IndexedDB. A
`fetch('/api/gemini')` in the same state fails, which is the denylist behaving correctly.

App icons are generated by [`scripts/generate-icons.mjs`](scripts/generate-icons.mjs) —
`npm run icons` — rather than committed as opaque binaries. It rasterises the mark and
encodes the PNGs with `node:zlib` alone, so no image library enters `devDependencies` for
four files. One full-bleed design serves both `any` and `maskable` because the mark sits
inside the 80% safe zone Android crops to.

## Talking to Gemini

The browser never sends prompt text. It names an action and passes typed parameters:

```ts
POST /api/gemini  { action: 'generate_lesson', params: { subject, grade, topicIndex } }
```

[`api/prompts.ts`](api/prompts.ts) validates the parameters and assembles the prompt, and
[`api/gemini.ts`](api/gemini.ts) forwards it. A request that fails validation is rejected
before any upstream call, so a bad one costs nothing.

This replaced a proxy that relayed whatever prompt string it was handed. It did check the
`Origin` header — but `Origin` is a header, and anything that isn't a browser sets it freely,
so the deployed function was a general-purpose Gemini endpoint billed to this project's key.
The origin check is still there; it is now a speed bump rather than the only thing standing
between the deployment and someone else's workload.

Three details worth naming:

- **Topics are indices, not strings.** `generate_lesson` takes a `topicIndex` into the shared
  catalogue in [`src/topics.ts`](src/topics.ts), which the proxy resolves against its own copy.
  The only thing a caller influences about that prompt is which of a fixed list of strings
  gets used.
- **`replace_question` sends no topic at all.** It used to pass `lesson.title`, which on a
  generated lesson is model output — so the model's own words became the topic line of the
  next prompt. Subject, grade and difficulty are enough, and none of them are free text.
- **The key moved from the query string to a header.** `?key=` ends up in access logs, proxy
  logs and error reports; `x-goog-api-key` generally does not.

**Model output is treated as untrusted input on the way back.** `JSON.parse(...) as Question`
was a promise to the compiler, not a check on the value.
[`src/utils/validate.ts`](src/utils/validate.ts) verifies the shape by hand — no zod, which is
~13 kB gzipped against a 47 kB bundle on a device chosen for being slow. A response that fails
makes `generateLesson` throw, and because `processSyncItem` already catches and returns false,
the sync engine turns that into a retry and then a drop with no changes to it.

It also reaches the DOM as untrusted input. Every screen builds markup with template strings
and `innerHTML`, so lesson titles, question prompts, choices and hints are markup unless
something escapes them. [`src/utils/escape.ts`](src/utils/escape.ts) is applied at every
interpolation of student or model text; it previously existed as three identical private
copies, which is how it ended up covering 6 of 33 sites.

## Performance

The rule here is measure first, and report what the measurement says even when it says the
planned optimisation was not worth doing. Raw Lighthouse reports and the method are in
[`perf/`](perf/).

Lighthouse, mobile preset, **6x CPU throttle**, against the local production preview so the
deltas isolate code changes from CDN variance:

| metric | before | after |
|---|---|---|
| Performance score | 99 | 99 |
| First Contentful Paint | 1.7s | **1.5s** |
| Speed Index | 1.7s | **1.5s** |
| Main-thread work | 0.4s | **0.3s** |
| Render-blocking requests | 3 | **2** |
| Third-party origins | 1 | **0** |

The score did not move because it was already 99 with 0ms of Total Blocking Time. A 47 kB
bundle with no framework does not have a cold-load problem, which is itself the answer to
"why no framework".

**Self-hosted fonts.** The largest single blocker was not the app. Lighthouse measured the
Google Fonts `@import` at 785ms of render-blocking time and 65.7 kB of transfer — more bytes
than the entire JS bundle. [`scripts/fetch-fonts.mjs`](scripts/fetch-fonts.mjs) pulls the
latin subset locally; Google serves eight subsets for a UI that is English-only.

The first attempt made it worse: writing one file per weight produced five byte-identical
copies of Inter, because Inter is a variable font and Google returns the same file for every
weight. 274 kB, against the 65.7 kB it was replacing. Deduplicating by URL and emitting one
`font-weight: 400 800` rule brought it to 85.5 kB on disk, of which a given page fetches only
the weights it uses — 64 kB on the onboarding screen.

Lighthouse predicted ~484ms of savings. The measured result was ~200ms off FCP and Speed
Index. The durable win is the other one: **zero third-party origins**, and `woff2` added to
the Workbox glob so typography now survives offline instead of dropping to system fonts.

**A compound index, and an untested migration.** `getLessonsForGrade` runs
`where({ grade, language })` on every subject navigation, and Dexie was warning at runtime
that it wanted a `[grade+language]` index. Adding one requires a new schema version:

| rows | before | after |
|---|---|---|
| 11 (a real student) | 0.5ms | 0.5ms |
| 3,011 (synthetic) | 12.5ms | **5.8ms** |

It earns nothing at real data sizes. It is in the schema because the query is O(rows)
without it, and because `version(1)` with no migration ever run is a migration path nobody
has tested.

**The optimisation that was planned and then abandoned.** This README used to claim the full
`innerHTML` rebuild on every navigation was "a visible stutter on a Snapdragon 400". It is
not. At 74 DOM nodes a full teardown measures 1.1ms; the sidebar, which is rebuilt despite
nothing in it changing but one class, is 0.4ms of that. Even multiplied by 6 it stays inside
a 16.7ms frame, and Lighthouse independently reports 0ms Total Blocking Time. Keeping the
sidebar mounted would have saved ~0.4ms and added a class of staleness bug, so it was not
done and the claim was deleted.

**One real bug, found while measuring it.** Clicking "Start Lesson" replaced the app root
*twice*. `setupSubjectPageHandlers` ran inside `render()` — before `app.appendChild(layout)`
— so `document.querySelector` found nothing, and a 100ms `setTimeout` was papering over the
race. It also double-bound: the screen already wires that button through the callback it is
passed, so one click ran two conflicting handlers, rendering the quiz screen and immediately
replacing it with the lesson screen. Both deferred-binding helpers are gone, the screens own
their wiring, and one click now renders once. `progress.ts` gained the `onNavigate` call it
declared and never made.

## Current limitations

This section is deliberately specific. Nothing below is fixed yet.

- **The boss battle does not feed the sync engine.** The quiz path records every answer via
  `markQuestionAnswered`, but `startBossBattle` builds its question pool with
  `flatMap(l => l.questions)` and discards the lesson id, so boss answers cannot be attributed
  to a lesson. Wiring it needs `BossState` to carry `{ lessonId, questionIndex }`.
- **Generated answers are checked for shape, not for truth.** `isValidQuestion` proves a
  question is *presentable* — four non-empty choices, `correctIndex` an integer inside the
  array, difficulty in range. Nothing verifies the marked answer is the mathematically
  correct one. A confidently wrong question still reaches the student; it just can't crash
  the grader any more.
- **The prompts still ask for JSON rather than using `responseSchema`.** Gemini's structured
  output would make malformed responses a non-event instead of something the validators have
  to catch. There is also no retry on 429 or 503 — those become failed queue items.
- **Rate limiting is per-instance.** Two counters in `api/gemini.ts` — 8/min per caller and
  10/min for the instance, the latter sized to the Gemini free tier's ~10 requests a minute for
  this project. But edge instances do not share memory, so N instances permit N times the
  global ceiling. It approximates well for the traffic a portfolio demo sees and is not a real
  quota; that needs Upstash or Vercel KV. The actual protection against abuse is that there is
  no prompt parameter to abuse.
- **There is no teacher view, by design.** A `src/screens/teacher.ts` existed but read the
  same browser's IndexedDB, so it could only ever show the student sitting at that device.
  It was unreachable from the UI and has been deleted rather than left as dead code —
  a real cross-device view needs a backend, which is out of scope for this project.
- **The boss battle still rebuilds its question pool on every render.** Unmeasured, and
  likely irrelevant at this data size — but it is the one hot path Day 3 did not put a
  number on.
- **Persistent storage is requested, not guaranteed.** `navigator.storage.persist()` runs at
  boot, but the browser decides. Chrome grants it on site-engagement heuristics, so a first
  visit is typically refused and an installed PWA typically is not. Nothing in the app can
  force it; without it, an OS low on space may evict IndexedDB and take a student's whole
  history with it.
- **Free-text prompts are mitigated, not solved.** The tutor chat and writing feedback take
  text the student typed, which no enum can constrain. It is length-capped, delimited, and
  labelled as data with an instruction not to follow it — which lowers the odds of a
  successful injection without eliminating them. Everything else the app sends is an enum
  or an index.
- **No URL routing.** Navigation is held in module-level state, so a page refresh returns to
  the onboarding screen and no view is linkable.
- **Test coverage stops short of the screens.** The sync engine, the proxy, the prompt
  builders, the output validators, the escaper and the failure classifiers are covered — 150
  cases. The screens and `db.ts` are not.

## Project history

Built April 25–26, 2026 at a 48-hour hackathon by a team of four. The state at submission is
tagged [`v0.1-hackathon`](https://github.com/JatanMehta19/MentorAI/releases/tag/v0.1-hackathon).
Everything after that tag is solo follow-on work.
