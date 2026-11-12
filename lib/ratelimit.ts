import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const hasUpstashConfig = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
)

const redis = hasUpstashConfig
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!
    })
  : null

// Login attempts: 5 per minute per IP — enough for a real user, too slow for brute force.
export const authRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '1 m'),
      prefix: 'fischer:auth'
    })
  : null

// Audits: 10 per hour per user — generous for real use, protects Anthropic billing
// from a runaway loop or a shared-account abuse case.
export const auditRateLimit = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '1 h'),
      prefix: 'fischer:audit'
    })
  : null

/**
 * Checks a rate limit and returns whether the request should proceed.
 * If Upstash isn't configured (e.g. local dev without env vars), this
 * fails OPEN — logs a warning but doesn't block — so local dev never
 * breaks because someone forgot to set up Redis. Production should
 * always have UPSTASH_REDIS_REST_URL/TOKEN set.
 */
export async function checkRateLimit(
  limiter: Ratelimit | null,
  identifier: string
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  if (!limiter) {
    console.warn('[fischer] Rate limiting skipped — Upstash not configured.')
    return { allowed: true, remaining: 999, resetAt: 0 }
  }

  try {
    const { success, remaining, reset } = await limiter.limit(identifier)
    return { allowed: success, remaining, resetAt: reset }
  } catch (err) {
    // A misconfigured or unreachable Redis must not lock everyone out.
    console.error('[fischer] Rate limit check failed — allowing request:', err instanceof Error ? err.message : err)
    return { allowed: true, remaining: 0, resetAt: 0 }
  }
}
