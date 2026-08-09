// api/gemini.ts
// Serverless proxy that keeps the Gemini API key server-side.
// The browser POSTs a prompt here and gets text back — it never sees the key.
//
// Runs on Vercel's Edge runtime in production. The exported helpers below are
// reused by the local dev/preview middleware in vite.config.ts, so the two
// entry points cannot drift apart.

export const config = { runtime: 'edge' };

// Vercel exposes env vars on `process.env`. Declared narrowly here rather than
// adding @types/node, which would leak Node globals into the browser code in src/.
declare const process: { env: Record<string, string | undefined> };

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent';

const MAX_PROMPT_CHARS    = 8000;
const UPSTREAM_TIMEOUT_MS = 15000;

export interface ProxyResult {
  status: number;
  body:   { text: string } | { error: string };
}

// ── Guards ────────────────────────────────────────────────────────────────────

/**
 * Reject cross-origin callers.
 * Without this the deployed function is an open Gemini relay billed to our key.
 * Browsers always send Origin on a JSON POST, so a same-origin app is unaffected.
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
 * Forward a prompt to Gemini and return its text.
 *
 * Never forwards the upstream error body — it can echo request details including
 * the key. Callers get a status and a generic message instead.
 */
export async function proxyGemini(
  prompt: unknown,
  apiKey: string | undefined
): Promise<ProxyResult> {
  if (!apiKey) {
    return { status: 503, body: { error: 'AI is not configured on this deployment.' } };
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { status: 400, body: { error: 'Missing prompt.' } };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return { status: 413, body: { error: 'Prompt too long.' } };
  }

  // A hung upstream call would stall the whole sync queue, which drains serially.
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal:  controller.signal,
    });

    if (!res.ok) {
      return { status: res.status, body: { error: `Gemini request failed (${res.status}).` } };
    }

    const data = await res.json() as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };

    // A blocked or empty completion is a real outcome, not a bug — guard every
    // level rather than indexing straight through and throwing a TypeError.
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string' || text === '') {
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

  let prompt: unknown;
  try {
    prompt = (await req.json() as { prompt?: unknown }).prompt;
  } catch {
    return json({ status: 400, body: { error: 'Invalid JSON body.' } });
  }

  return json(await proxyGemini(prompt, process.env.GEMINI_API_KEY));
}
