import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import { config } from '../config.js';

const JWT_ISSUER = 'aegisdial.api';
const JWT_AUDIENCE = 'aegisdial.app';
const JWT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Known dev default — matches the value in src/config.ts. We refuse to
// start in production if this is still the active value, because the
// default is public (checked into git) and anyone could mint valid
// user JWTs with it. Parallel to the DATA_ENCRYPTION_KEY guard in
// src/lib/crypto.ts.
const DEV_JWT_DEFAULT = 'dev-only-jwt-secret-change-me-immediately-in-production-12345';
if (config.NODE_ENV === 'production' && config.JWT_SECRET === DEV_JWT_DEFAULT) {
  throw new Error(
    'FATAL: JWT_SECRET is still the dev default in production. ' +
      'Set a real secret before boot: in Railway, Variables → Add → `JWT_SECRET` = $(openssl rand -hex 32). ' +
      'Refusing to start — any attacker with the code can otherwise mint valid user tokens.',
  );
}

const hmacSecret = new TextEncoder().encode(config.JWT_SECRET);

export interface AppJwtClaims {
  sub: string; // user id
  auth_method: 'apple' | 'email';
  // Tier is informational only at token-issue time; the authoritative check
  // is the subscriptions table read every request by requireAppUser.
  tier: 'pending' | 'pro' | 'expired' | 'cancelled';
}

export async function signAppJwt(claims: AppJwtClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS)
    .sign(hmacSecret);
}

export async function verifyAppJwt(token: string): Promise<AppJwtClaims> {
  const { payload } = await jwtVerify(token, hmacSecret, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  return {
    sub: payload.sub as string,
    auth_method: payload.auth_method as AppJwtClaims['auth_method'],
    tier: payload.tier as AppJwtClaims['tier'],
  };
}

// Apple public keys — rotated, cached by jose.
const appleJwks = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export interface AppleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  is_private_email?: boolean;
}

export async function verifyAppleIdToken(idToken: string): Promise<AppleIdTokenClaims> {
  const { payload } = await jwtVerify(idToken, appleJwks, {
    issuer: 'https://appleid.apple.com',
    audience: config.APPLE_CLIENT_ID,
  });
  return {
    sub: payload.sub as string,
    email: payload.email as string | undefined,
    email_verified: payload.email_verified === true || payload.email_verified === 'true',
    is_private_email: payload.is_private_email === true || payload.is_private_email === 'true',
  };
}
