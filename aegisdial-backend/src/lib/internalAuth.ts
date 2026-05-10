// HTTP basic auth gate for /internal/* routes.
//
// Single-password — the username is ignored. Why basic auth and not a
// cookie session? Three reasons:
//   1. The dashboard is for one person (Jesiah). No multi-user, no
//      "log out" need.
//   2. Browsers cache basic-auth credentials for the session, so the
//      UX is "type once, then it just works."
//   3. Zero new dependencies — no @fastify/cookie, no signed-cookie
//      secrets to rotate. Just an env var.
//
// The constant-time compare prevents timing-side-channel password
// guessing. Without it, response time differences would let an attacker
// brute-force one character at a time.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

function constantTimeEquals(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers. Pad the shorter to
  // the longer with zero bytes (which won't match anything in the real
  // password since real passwords don't contain NULs), then compare.
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const len = Math.max(ab.length, bb.length);
  const ap = Buffer.alloc(len);
  const bp = Buffer.alloc(len);
  ab.copy(ap);
  bb.copy(bp);
  // Returning true only if both the constant-time compare passes AND
  // the original lengths match — otherwise a short password could
  // collide via padding.
  return timingSafeEqual(ap, bp) && ab.length === bb.length;
}

/**
 * Fastify preHandler — call this on every /internal/* route. On
 * miss, returns 401 with WWW-Authenticate so the browser prompts.
 */
export async function requireInternalPassword(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = config.INTERNAL_DASHBOARD_PASSWORD;
  if (!expected) {
    // Mis-configured deploy. Better to lock the dashboard down than
    // let it be reachable with no password — fail closed.
    reply.code(503).send({ error: 'internal_dashboard_disabled' });
    return;
  }

  const header = req.headers['authorization'];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) {
    reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="AegisDial Internal", charset="UTF-8"')
      .send({ error: 'auth_required' });
    return;
  }

  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  // "user:password" — split on first colon only; the password may
  // legitimately contain colons.
  const colonAt = decoded.indexOf(':');
  const submitted = colonAt < 0 ? decoded : decoded.slice(colonAt + 1);

  if (!constantTimeEquals(submitted, expected)) {
    reply
      .code(401)
      .header('WWW-Authenticate', 'Basic realm="AegisDial Internal", charset="UTF-8"')
      .send({ error: 'bad_password' });
    return;
  }

  // Belt-and-braces — make sure these responses never get cached by
  // intermediaries or the browser.
  reply.header('Cache-Control', 'private, no-store, max-age=0');
  reply.header('X-Robots-Tag', 'noindex, nofollow');
}
