// api/gemini.ts
// Serverless proxy that keeps the Gemini API key server-side.
// The browser names an action and gets text back — it never sees the key, and it
// never supplies prompt text.
//
// Runs on Vercel's Edge runtime in production. The exported helpers below are
// reused by the local dev/preview middleware in vite.config.ts, so the two
// entry points cannot drift apart.

import { buildPrompt } from './prompts';

export const config = { runtime: 'edge' };

// Vercel exposes env vars on `process.env`. Declared narrowly here rather than
// adding @types/node, which would leak Node globals into the browser code in src/.
declare const process: { env: Record<string, string | undefined> };

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

// Every parameter that feeds a prompt is already length-capped in prompts.ts.
// This is a backstop in case a builder grows a field and forgets one.
const MAX_PROMPT_CHARS    = 8000;
// Measured against gemini-3.6-flash generating a full five-question lesson:
// ~11s, ~12s, ~52s over three runs. 15s cut off the tail, and the sync queue
// then burned all three retries on the same doomed call. 30s also keeps the
// function inside Vercel's Edge duration ceiling; anything slower than that is
// left for the queue to retry, which is what the queue is for.
const UPSTREAM_TIMEOUT_MS = 30000;

export interface ProxyResult {
  status: number;
  body:   { text: string } | { error: string };
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;

// Sized against the upstream quota rather than picked round. The Gemini free
// tier allows this project roughly 10 requests per minute, shared across every
// caller — so a per-caller ceiling of 20 was looser than the limit it was
// supposed to protect, and two simultaneous visitors could exceed Gemini's
// quota without this noticing.
const RATE_LIMIT_MAX        = 8;   // one caller cannot exhaust the project alone
const RATE_LIMIT_GLOBAL_MAX = 10;  // matches the free-tier project ceiling

const GLOBAL_KEY = '__global__'; // not a valid IP, so it cannot collide with a caller

/**
 * Per-instance request counters: one row per caller, plus one for the instance
 * as a whole.
 *
 * The honest caveat is that edge instances do not share memory, so N instances
 * permit N × the global ceiling. That makes this a good approximation for the
 * traffic a portfolio demo actually sees — usually one warm instance — and not
 * a real quota. A real one needs shared state (Upstash, Vercel KV), which isn't
 * worth a dependency here; the actual protection against abuse is that there is
 * no longer a prompt parameter to abuse.
 *
 * The point of the global row is narrower: keep the app inside its own free-tier
 * quota so visitors get served, instead of discovering the limit as upstream
 * 429s halfway through a demo.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

function bump(key: string, max: number, now: number): boolean {
  const entry = hits.get(key);

  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > max;
}

export function isRateLimited(key: string, now: number = Date.now()): boolean {
  // Expired rows would otherwise accumulate for the life of the instance.
  if (hits.size > 1000) {
    for (const [k, v] of hits) if (now >= v.resetAt) hits.delete(k);
  }

  // Both counters always advance: short-circuiting would let a caller who is
  // already over their own limit avoid being counted against the global one.
  const caller = bump(key, RATE_LIMIT_MAX, now);
  const global = bump(GLOBAL_KEY, RATE_LIMIT_GLOBAL_MAX, now);
  return caller || global;
}

/** Clear the counters. Used by tests; instances are short-lived in production. */
export function resetRateLimit(): void {
  hits.clear();
}

// ── Guards ────────────────────────────────────────────────────────────────────

/**
 * Reject cross-origin callers.
 * Browsers always send Origin on a JSON POST, so a same-origin app is unaffected.
 *
 * A speed bump rather than a boundary: Origin is a header, and anything that is
 * not a browser sets it freely. What actually closed the open-relay hole is that
 * the caller can no longer supply prompt text at all — see prompts.ts.
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Build the prompt for `action` and forward it to Gemini.
 *
 * Never forwards the upstream error body — it can echo request details including
 * the key. Callers get a status and a generic message instead.
 */
export async function proxyGemini(
  action: unknown,
  params: unknown,
  apiKey: string | undefined
): Promise<ProxyResult> {
  if (!apiKey) {
    return { status: 503, body: { error: 'AI is not configured on this deployment.' } };
  }

  // Rejected before any upstream call, so a bad request costs nothing.
  const built = buildPrompt(action, params);
  if (!built.ok) {
    return { status: 400, body: { error: built.error } };
  }
  if (built.prompt.length > MAX_PROMPT_CHARS) {
    return { status: 413, body: { error: 'Prompt too long.' } };
  }

  // A hung upstream call would stall the whole sync queue, which drains serially.
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // A header rather than ?key= in the URL. Query strings turn up in access
        // logs, proxy logs and error reports; headers generally do not.
        'x-goog-api-key': apiKey,
      },
      body:   JSON.stringify({ contents: [{ parts: [{ text: built.prompt }] }] }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { status: res.status, body: { error: `Gemini request failed (${res.status}).` } };
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    // Scan every part instead of indexing [0]. Thinking models interleave parts
    // that carry a thoughtSignature and no text, so the first entry is not
    // reliably the answer. A blocked or empty completion is a real outcome, not
    // a bug, which is why it is a guarded 502 and not a TypeError.
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map(part => part.text)
      .filter((t): t is string => typeof t === 'string' && t !== '')
      .join('');

    if (text === '') {
      return { status: 502, body: { error: 'Gemini returned no usable content.' } };
    }

    return { status: 200, body: { text } };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      status: aborted ? 504 : 502,
      body:   { error: aborted ? 'Gemini request timed out.' : 'Could not reach Gemini.' },
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Edge handler ──────────────────────────────────────────────────────────────

export default async function handler(req: Request): Promise<Response> {
  const json = (result: ProxyResult): Response =>
    new Response(JSON.stringify(result.body), {
      status:  result.status,
      headers: { 'Content-Type': 'application/json' },
    });

  if (req.method !== 'POST') {
    return json({ status: 405, body: { error: 'Method not allowed.' } });
  }
  if (!isSameOrigin(req.headers.get('origin'), req.headers.get('host'))) {
    return json({ status: 403, body: { error: 'Forbidden.' } });
  }

  // Vercel overwrites x-forwarded-for at the edge, so the first entry is the
  // caller-facing IP rather than something the caller chose.
  const caller = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (isRateLimited(caller)) {
    return json({ status: 429, body: { error: 'Too many requests. Try again shortly.' } });
  }

  let body: { action?: unknown; params?: unknown };
  try {
    body = await req.json() as { action?: unknown; params?: unknown };
  } catch {
    return json({ status: 400, body: { error: 'Invalid JSON body.' } });
  }

  return json(await proxyGemini(body.action, body.params, process.env.GEMINI_API_KEY));
}
