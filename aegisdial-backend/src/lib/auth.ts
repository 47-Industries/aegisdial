import type { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { verifyAppJwt } from './jwt.js';
import { currentTier, ensureTierPersisted, type UserTier } from './subscription.js';

export interface AppUser {
  id: string;
  auth_method: 'apple' | 'email';
  tier: UserTier;
}

declare module 'fastify' {
  interface FastifyRequest {
    appUser?: AppUser;
  }
}

// Admin / crawler endpoints still use the shared secret — not user-facing.
export async function requireBearer(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_bearer' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  if (token !== config.API_SHARED_SECRET) {
    reply.code(401).send({ error: 'invalid_token' });
    return;
  }
}

// Consumer endpoints require a per-user JWT issued by /auth/*.
// Falls back to accepting the dev shared secret so local curl tests and
// existing dev scripts keep working.
export async function requireAppUser(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'missing_bearer' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();

  // Dev-only shortcut: bearer = API_SHARED_SECRET maps to a synthetic
  // pro user. BOTH flags must be true — a non-production env alone is
  // not sufficient because "staging" counts as non-production. The new
  // ALLOW_DEV_BEARER must be explicitly set in local dev.
  if (token === config.API_SHARED_SECRET && config.ALLOW_DEV_BEARER && config.NODE_ENV !== 'production') {
    req.appUser = {
      id: '00000000-0000-0000-0000-000000000000',
      auth_method: 'apple',
      tier: 'pro',
    };
    return;
  }

  try {
    const claims = await verifyAppJwt(token);
    const tier = await currentTier(claims.sub);
    await ensureTierPersisted(claims.sub, tier);
    req.appUser = {
      id: claims.sub,
      auth_method: claims.auth_method as 'apple' | 'email',
      tier,
    };
  } catch {
    reply.code(401).send({ error: 'invalid_token' });
    return;
  }
}

// Gate for endpoints that require an active paid subscription. Call after
// requireAppUser. Returns 402 Payment Required if the user hasn't paid.
export async function requireProTier(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const user = req.appUser;
  if (!user) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  if (user.tier !== 'pro') {
    reply.code(402).send({
      error: 'subscription_required',
      tier: user.tier,
      message:
        'AegisDial is a paid subscription — bank-grade live call protection requires an active plan.',
    });
    return;
  }
}

// Optional user context — for endpoints that accept either authenticated or
// anonymous traffic but attribute results when a user is present.
export async function optionalAppUser(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return;
  const token = header.slice('Bearer '.length).trim();
  // Dev-only shortcut: bearer = API_SHARED_SECRET maps to a synthetic
  // pro user. BOTH flags must be true — a non-production env alone is
  // not sufficient because "staging" counts as non-production. The new
  // ALLOW_DEV_BEARER must be explicitly set in local dev.
  if (token === config.API_SHARED_SECRET && config.ALLOW_DEV_BEARER && config.NODE_ENV !== 'production') {
    req.appUser = {
      id: '00000000-0000-0000-0000-000000000000',
      auth_method: 'apple',
      tier: 'pro',
    };
    return;
  }
  try {
    const claims = await verifyAppJwt(token);
    const tier = await currentTier(claims.sub);
    req.appUser = {
      id: claims.sub,
      auth_method: claims.auth_method as 'apple' | 'email',
      tier,
    };
  } catch {
    // ignore — leave req.appUser unset
  }
}
