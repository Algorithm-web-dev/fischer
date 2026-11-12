/**
 * Who may call what. Pure — used by middleware.ts and unit tested.
 *
 * Roles: admin, analyst, viewer (team) · client (portal users) · null (no access).
 * The database enforces the same rules with row-level security (migration
 * 0011); this layer gives clear errors and keeps client users inside /portal.
 */
export type Role = 'admin' | 'analyst' | 'viewer' | 'client' | null

const ADMIN_ONLY = [/^\/admin(\/|$)/, /^\/api\/team(\/|$)/, /^\/api\/errors(\/|$)/, /^\/api\/clients\/[^/]+\/export$/]
const CLIENT_ALLOWED = [/^\/portal(\/|$)/, /^\/api\/portal(\/|$)/]

export function accessDecision(role: Role, pathname: string, method: string):
  | { allow: true }
  | { allow: false; status: 401 | 403; redirect?: string; message: string } {
  const isApi = pathname.startsWith('/api/')
  if (!role) return { allow: false, status: 403, redirect: '/?error=no_access', message: 'Your account has no access to Fischer. Ask an admin to invite you.' }

  if (role === 'client') {
    if (CLIENT_ALLOWED.some(r => r.test(pathname))) return { allow: true }
    return { allow: false, status: 403, redirect: isApi ? undefined : '/portal', message: 'Not available to client accounts.' }
  }

  // Team members never need the portal; send them to the full app.
  if (/^\/portal(\/|$)/.test(pathname)) return { allow: false, status: 403, redirect: '/clients', message: 'The portal is for client accounts.' }

  if (ADMIN_ONLY.some(r => r.test(pathname)) && role !== 'admin') {
    return { allow: false, status: 403, redirect: isApi ? undefined : '/clients', message: 'Admins only.' }
  }
  // Deleting a client is admin-only too.
  if (/^\/api\/clients\/[^/]+$/.test(pathname) && method === 'DELETE' && role !== 'admin') {
    return { allow: false, status: 403, message: 'Only admins can delete a client.' }
  }
  if (role === 'viewer' && isApi && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return { allow: false, status: 403, message: 'Viewers have read-only access.' }
  }
  return { allow: true }
}
