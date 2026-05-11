import { Redis } from 'ioredis';
import { config } from '../config.js';

interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<'OK' | null>;
  /**
   * Atomic "set if not exists" with TTL — maps to Redis `SET NX EX`.
   * Returns 'OK' when the caller won the race, null when another
   * process already held the key.
   */
  setNX(key: string, value: string, ttlSeconds: number): Promise<'OK' | null>;
  /**
   * Atomic INCR — increments the counter at `key` by 1 (creating it
   * at 0 if absent) and returns the new value. Paired with `expire`
   * to build per-window rate-limit counters.
   *
   * NOTE: INCR alone does NOT set TTL — the resulting key persists
   * forever unless `expire` is set afterward. For atomic
   * INCR+EXPIRE-on-first-incr semantics (no crash window where the
   * key exists without TTL), use `incrWithTtl` instead.
   */
  incr(key: string): Promise<number>;
  /**
   * Set TTL on an existing key. Returns 1 when the key existed and
   * the TTL was applied, 0 when the key was absent. Idempotent —
   * calling it on a key with an existing TTL replaces the TTL.
   */
  expire(key: string, ttlSeconds: number): Promise<number>;
  /**
   * Atomic increment + TTL-on-first-creation in a single round-trip.
   *
   * Semantics: increments `key` by 1. If the key did not exist
   * before this call (i.e., the new value is 1), also sets the TTL
   * to `ttlSeconds`. Otherwise the existing TTL is left untouched.
   * Returns the new value.
   *
   * Replaces the two-RTT `incr(); if (==1) expire()` pattern. The
   * old pattern had a crash window between INCR and EXPIRE where a
   * process death would leave the key alive forever without a TTL —
   * orphan-key leak over time, plus stuck counters for unlucky users
   * (see adversarial review M-1 on commit fabc900).
   *
   * Use this for any per-window rate-limit counter.
   */
  incrWithTtl(key: string, ttlSeconds: number): Promise<number>;
  del(key: string): Promise<number>;
  ping(): Promise<string>;
  quit(): Promise<'OK'>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

class InMemoryCache implements CacheClient {
  private store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number): Promise<'OK'> {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return 'OK';
  }

  async setNX(key: string, value: string, ttlSeconds: number): Promise<'OK' | null> {
    const existing = this.store.get(key);
    if (existing && (existing.expiresAt === null || existing.expiresAt > Date.now())) {
      return null;
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return 'OK';
  }

  async incr(key: string): Promise<number> {
    const entry = this.store.get(key);
    // Treat expired or absent entries as starting from 0.
    const expired = entry && entry.expiresAt !== null && entry.expiresAt < Date.now();
    const current = !entry || expired ? 0 : parseInt(entry.value, 10) || 0;
    const next = current + 1;
    this.store.set(key, {
      value: String(next),
      // Preserve existing TTL on increment (Redis behavior). Callers
      // who want a fresh TTL should call expire() after the first incr.
      expiresAt: expired || !entry ? null : entry.expiresAt,
    });
    return next;
  }

  async expire(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return 0;
    }
    this.store.set(key, {
      value: entry.value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    return 1;
  }

  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.store.get(key);
    const expired = entry && entry.expiresAt !== null && entry.expiresAt < Date.now();
    const current = !entry || expired ? 0 : parseInt(entry.value, 10) || 0;
    const next = current + 1;
    // If the key did not exist OR was expired, this is effectively a
    // fresh counter — set the TTL. Otherwise preserve the existing
    // TTL (same semantics as the Redis Lua EVAL).
    const expiresAt = !entry || expired
      ? Date.now() + ttlSeconds * 1000
      : entry.expiresAt;
    this.store.set(key, { value: String(next), expiresAt });
    return next;
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }

  on(): this {
    return this;
  }
}

function createClient(): CacheClient {
  if (config.REDIS_URL.startsWith('memory://')) {
    return new InMemoryCache();
  }
  const client: Redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  client.on('error', (err: Error) => {
    console.error('Redis error', err);
  });
  // Bridge to our narrower CacheClient interface. ioredis' `set` type
  // overloads don't always resolve cleanly for the 5-arg NX+EX form,
  // so we wrap it here behind a single-purpose `setNX` method.
  const wrapped: CacheClient = {
    get: (key) => client.get(key),
    set: (key, value, mode, ttlSeconds) =>
      client.set(key, value, mode, ttlSeconds) as Promise<'OK' | null>,
    setNX: async (key, value, ttlSeconds) => {
      // Cast through `any` for the NX-EX overload; ioredis accepts it
      // at runtime — this is the standard Redis "SET key value EX ttl NX"
      // command.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = await (client as any).set(key, value, 'EX', ttlSeconds, 'NX');
      return res === 'OK' ? 'OK' : null;
    },
    incr: (key) => client.incr(key),
    expire: (key, ttlSeconds) => client.expire(key, ttlSeconds),
    // Atomic INCR + EXPIRE-on-first-incr via Lua. Single RTT, no
    // crash window. ioredis serializes the script to Redis (Upstash
    // supports EVAL). The script returns the new counter value.
    incrWithTtl: async (key, ttlSeconds) => {
      const SCRIPT = `
        local v = redis.call('INCR', KEYS[1])
        if v == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        return v
      `;
      // ioredis.eval returns `string | number | Buffer | null` — INCR
      // always yields an integer so a number-cast is safe.
      const res = await (client as unknown as {
        eval: (s: string, n: number, k: string, a: string) => Promise<number | string>;
      }).eval(SCRIPT, 1, key, String(ttlSeconds));
      return typeof res === 'number' ? res : parseInt(String(res), 10);
    },
    del: (key) => client.del(key),
    ping: () => client.ping(),
    quit: () => client.quit() as Promise<'OK'>,
    on: (event, listener) => client.on(event, listener),
  };
  return wrapped;
}

export const redis: CacheClient = createClient();

const DEFAULT_TTL_SECONDS = 60 * 60;

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}

/**
 * Atomic "set if not exists" with TTL. Returns true when the caller
 * successfully acquired the slot (previous value was absent), false
 * when some other process already held it. Maps to Redis `SET NX EX`
 * which is single-instance-safe; correctness across multiple Fly
 * instances depends on the Redis itself, which is shared (Upstash).
 *
 * Use for distributed single-flight / lock-style coordination. Do NOT
 * use for replacing an existing value — that's what `cacheSet` is for.
 */
export async function cacheSetNX<T>(
  key: string,
  value: T,
  ttlSeconds: number,
): Promise<boolean> {
  const res = await redis.setNX(key, JSON.stringify(value), ttlSeconds);
  return res === 'OK';
}

export async function cacheInvalidate(key: string): Promise<void> {
  await redis.del(key);
}

export function verdictCacheKey(e164: string): string {
  return `verdict:${e164}`;
}

export async function shutdownCache(): Promise<void> {
  await redis.quit();
}
