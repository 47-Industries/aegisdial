// Fallback hosting for the legal + support HTML pages.
//
// Primary host is www.aegisdial.com (separate aegisdial-web Railway
// service). If that service is unhealthy — or if for any reason the
// app needs to point at the API host instead — these routes serve the
// same static HTML out of aegisdial-backend/legal/ via the API origin
// at api.aegisdial.com/privacy, /terms, /support, and /legal.
//
// The HTML files are checked into git; the Dockerfile copies the
// `legal/` directory into the runtime image alongside `public/`.

import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEGAL_DIR = join(__dirname, '..', '..', 'legal');

const cache = new Map<string, string>();
async function loadHtml(filename: string): Promise<string> {
  const cached = cache.get(filename);
  if (cached) return cached;
  const html = await readFile(join(LEGAL_DIR, filename), 'utf8');
  cache.set(filename, html);
  return html;
}

export async function publicWebRoutes(app: FastifyInstance): Promise<void> {
  const routes: Array<[string, string]> = [
    ['/legal', 'index.html'],
    ['/privacy', 'privacy.html'],
    ['/terms', 'terms.html'],
    ['/support', 'support.html'],
  ];
  for (const [path, file] of routes) {
    app.get(path, async (_req, reply) => {
      const html = await loadHtml(file);
      reply
        .type('text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=300')
        .send(html);
    });
  }
}
