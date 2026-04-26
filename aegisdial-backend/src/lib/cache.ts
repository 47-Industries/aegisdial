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
