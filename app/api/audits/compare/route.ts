import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase'
import type { AuditResult, FrictionPoint } from '@/lib/claude'

/**
 * Compares the two most recent completed audits for a given client + page URL.
 * Returns the score delta, which friction points were resolved vs still present,
 * new friction points that appeared, and data source comparisons.
 *
 * This is what makes Fischer a monitoring tool, not a one-shot audit:
 * "You were at 54, now you're at 71. Here's what changed."
 */
export async function GET(req: NextRequest) {
  const supabase = createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const clientId = req.nextUrl.searchParams.get('clientId')
  const pageUrl = req.nextUrl.searchParams.get('pageUrl')

  if (!clientId || !pageUrl) {
    return NextResponse.json({ error: 'clientId and pageUrl query params are required.' }, { status: 400 })
  }

  // Pull the two most recent completed audits for this client + page
  const { data: audits, error } = await supabase
    .from('audits')
    .select('id, fischer_score, output, completed_at, ga4_data, clarity_data, pagespeed_desktop, pagespeed_mobile, capture_metadata')
    .eq('client_id', clientId)
    .eq('page_url', pageUrl)
    .eq('status', 'complete')
    .order('completed_at', { ascending: false })
    .limit(2)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!audits || audits.length === 0) {
    return NextResponse.json({ error: 'No completed audits found for this client and page.' }, { status: 404 })
  }

  if (audits.length === 1) {
    // Only one audit exists — return it as the baseline with no comparison
    const current = audits[0]
    const currentOutput = current.output as AuditResult
    return NextResponse.json({
      hasComparison: false,
      current: {
        auditId: current.id,
        fischerScore: current.fischer_score,
        completedAt: current.completed_at,
        frictionPointCount: currentOutput.frictionPoints?.length || 0,
        summary: currentOutput.summary
      },
      message: 'This is the first audit for this page — run another audit after making changes to see a comparison.'
    })
  }

  const current = audits[0]
  const previous = audits[1]
  const currentOutput = current.output as AuditResult
  const previousOutput = previous.output as AuditResult

  // Score delta
  const scoreDelta = (current.fischer_score || 0) - (previous.fischer_score || 0)

  // Friction point diff — match by title (fuzzy) to identify resolved vs remaining
  const currentFrictions = currentOutput.frictionPoints || []
  const previousFrictions = previousOutput.frictionPoints || []

  const resolved: FrictionPoint[] = []
  const remaining: FrictionPoint[] = []
  const newIssues: FrictionPoint[] = []

  const matchedPreviousTitles = new Set<string>()

  for (const fp of currentFrictions) {
    const match = previousFrictions.find(prev =>
      !matchedPreviousTitles.has(prev.title) &&
      isSimilar(fp.title, prev.title)
    )
    if (match) {
      matchedPreviousTitles.add(match.title)
      remaining.push(fp)
    } else {
      newIssues.push(fp)
    }
  }

  for (const fp of previousFrictions) {
    if (!matchedPreviousTitles.has(fp.title)) {
      resolved.push(fp)
    }
  }

  // Revenue impact comparison
  const currentRevenue = currentOutput.revenueImpact
  const previousRevenue = previousOutput.revenueImpact
  const revenueComparison = currentRevenue && previousRevenue
    ? {
        cvrChange: {
          from: previousRevenue.currentConversionRate,
          to: currentRevenue.currentConversionRate,
          delta: Math.round((currentRevenue.currentConversionRate - previousRevenue.currentConversionRate) * 100) / 100
        },
        revenueChange: {
          from: previousRevenue.currentMonthlyRevenue,
          to: currentRevenue.currentMonthlyRevenue,
          delta: currentRevenue.currentMonthlyRevenue - previousRevenue.currentMonthlyRevenue
        }
      }
    : null

  // Data source comparison
  const dataSources = {
    current: current.capture_metadata || {},
    previous: previous.capture_metadata || {}
  }

  return NextResponse.json({
    hasComparison: true,

    current: {
      auditId: current.id,
      fischerScore: current.fischer_score,
      completedAt: current.completed_at,
      frictionPointCount: currentFrictions.length,
      summary: currentOutput.summary
    },
    previous: {
      auditId: previous.id,
      fischerScore: previous.fischer_score,
      completedAt: previous.completed_at,
      frictionPointCount: previousFrictions.length,
      summary: previousOutput.summary
    },

    scoreDelta,
    scoreDirection: scoreDelta > 0 ? 'improved' : scoreDelta < 0 ? 'declined' : 'unchanged',

    frictionDiff: {
      resolved: resolved.map(fp => ({ title: fp.title, severity: fp.severity, location: fp.location })),
      remaining: remaining.map(fp => ({ title: fp.title, severity: fp.severity, location: fp.location })),
      newIssues: newIssues.map(fp => ({ title: fp.title, severity: fp.severity, location: fp.location })),
      resolvedCount: resolved.length,
      remainingCount: remaining.length,
      newIssueCount: newIssues.length
    },

    revenueComparison,
    dataSources
  })
}

/**
 * Fuzzy title matching — two friction points are "the same issue" if their
 * titles share most of their significant words. This handles cases like
 * "Weak CTA copy on hero" vs "Hero section CTA copy is generic."
 */
function isSimilar(a: string, b: string): boolean {
  const wordsA = normalise(a)
  const wordsB = normalise(b)

  // If either is very short, require exact match
  if (wordsA.length <= 2 || wordsB.length <= 2) {
    return wordsA.join(' ') === wordsB.join(' ')
  }

  // Count shared significant words
  const setA = new Set(wordsA)
  const shared = wordsB.filter(w => setA.has(w)).length
  const maxLen = Math.max(wordsA.length, wordsB.length)

  return shared / maxLen >= 0.5
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'on', 'in', 'of', 'to', 'and', 'for', 'with', 'no', 'not'])

function normalise(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
}
