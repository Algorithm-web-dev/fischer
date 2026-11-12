import { NextRequest, NextResponse } from 'next/server'
import { requireRole, bad } from '@/lib/api'
import { createSupabaseServiceClient } from '@/lib/supabase'
import { exportClientData } from '@/lib/client-data'
import { logActivity } from '@/lib/activity'

export const maxDuration = 60

/** Admin: download everything held about a client as JSON (POPIA/GDPR access requests). */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireRole('admin'); if (auth.error) return auth.error
  try {
    const data = await exportClientData(createSupabaseServiceClient(), params.id)
    await logActivity(auth.supabase, auth.user, 'client.export', { entityType: 'client', entityId: params.id, clientId: params.id })
    const name = String((data.client as any).name ?? 'client').replace(/[^a-z0-9]+/gi, '-')
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}-fischer-export.json"` }
    })
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Export failed.', 500)
  }
}
