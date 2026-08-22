// vite.config.ts
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { proxyGemini, isSameOrigin } from './api/gemini';

// This file runs in Node at config time and sits outside the browser typecheck
// program, so the Node request/response shapes are described structurally here
// rather than pulling in @types/node just for two signatures.
interface NodeReq {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  setEncoding(encoding: string): void;
  on(event: string, listener: (chunk: string) => void): void;
}

interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

/**
 * Serves /api/gemini locally so `npm run dev` and `npm run preview` behave like
 * the deployed Vercel Function. Registered on the preview server too — that is
 * how the app gets verified in a browser, and without it AI calls would fail
 * there while appearing to work in dev.
 *
 * Delegates to the same proxyGemini/isSameOrigin used by the real function.
 */
function geminiLocalProxy(apiKey: string | undefined): Plugin {
  const handle = (req: NodeReq, res: NodeRes): void => {
    const send = (status: number, body: unknown): void => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });

    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    const host   = typeof req.headers.host   === 'string' ? req.headers.host   : null;
    if (!isSameOrigin(origin, host)) return send(403, { error: 'Forbidden.' });

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      void (async () => {
        let prompt: unknown;
        try {
          prompt = (JSON.parse(raw) as { prompt?: unknown }).prompt;
        } catch {
          return send(400, { error: 'Invalid JSON body.' });
        }
        const result = await proxyGemini(prompt, apiKey);
        send(result.status, result.body);
      })();
    });
  };

  return {
    name: 'mentorai:gemini-local-proxy',
    configureServer(server)        { server.middlewares.use('/api/gemini', handle); },
    configurePreviewServer(server) { server.middlewares.use('/api/gemini', handle); },
  };
}

export default defineConfig(({ mode }) => {
  // Empty prefix so loadEnv reads GEMINI_API_KEY, which is deliberately NOT
  // VITE_-prefixed — a VITE_ name would be inlined into the client bundle and
  // recreate the exact leak this proxy exists to fix. This value stays in Node.
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      geminiLocalProxy(env.GEMINI_API_KEY),
      // The only service worker in the project. A hand-written public/sw.js used
      // to ship alongside this one; nothing registered it and Workbox emitted to
      // the same dist/sw.js path anyway, so it was silently overwritten at build.
      VitePWA({
        registerType: 'autoUpdate',
        workbox: {
          // Cache everything the app needs — JS, CSS, HTML, images, AND lesson JSONs
          globPatterns: ['**/*.{js,ts,css,html,ico,png,svg,webp,json}'],
          // The proxy is a live network call; never serve it from cache.
          navigateFallbackDenylist: [/^\/api\//],
        },
        manifest: {
          name:             'MentorAI',
          short_name:       'MentorAI',
          description:      'Offline-first AI study companion for grades 6–8',
          theme_color:      '#6C63FF',
          background_color: '#0D0D1A',
          display:          'standalone',
          start_url:        '/',
          // Built by scripts/generate-icons.mjs. Full-bleed with the mark inside
          // the 80% safe zone, so one file covers both `any` and `maskable`
          // rather than shipping a separate cropped variant.
          icons: [
            { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
            { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        },
      }),
    ],
    // Makes sure Vite can resolve imports from src/ and utils/
    resolve: {
      alias: {
        '@': '/src',
      },
    },
  };
});
