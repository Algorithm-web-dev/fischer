import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { cookies } from 'next/headers'

/**
 * Server-side Supabase client scoped to the current request's auth session.
 * Use this in API routes / server components — it reads the user's session
 * from cookies, so RLS policies (`auth.role() = 'authenticated'`) apply correctly.
 */
export function createSupabaseServerClient() {
  const cookieStore = cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options })
          } catch {
            // Called from a Server Component with no writable cookie store — safe to ignore,
            // middleware.ts refreshes the session on every request anyway.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options })
          } catch {
            // Same as above.
          }
        }
      }
    }
  )
}

/**
 * Service-role client for trusted server-only operations (e.g. writing audit
 * results after a background job). NEVER expose this key to the client.
 * Bypasses RLS — use only where the calling code has already verified the user.
 */
import { createClient } from '@supabase/supabase-js'

export function createSupabaseServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false } }
  )
}
