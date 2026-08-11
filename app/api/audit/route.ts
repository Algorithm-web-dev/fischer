import { NextRequest, NextResponse } from 'next/server'
import { runFischerAudit, AuditInput } from '@/lib/claude'
import { scrapePage, parseHtml, ScrapeResult, ScrapedContent } from '@/lib/scraper'
import { captureScreenshots, ScreenshotResult, ViewportShot } from '@/lib/screenshot'
import { assessConfidence, isFullyConfident } from '@/lib/confidence'
import { fetchPageSpeedBoth } from '@/lib/pagespeed'
import { fetchGA4AuditData, GA4AuditData } from '@/lib/ga4-audit'
import { fetchClarityData, ClarityResult } from '@/lib/clarity'
import { createSupabaseServerClient } from '@/lib/supabase'
import { auditRateLimit, checkRateLimit } from '@/lib/ratelimit'

export const maxDuration = 120

interface AuditRequestBody extends AuditInput {
  auditId?: string
}

export async function POST(req: NextRequest) {
  const supabase = createSupabaseServerClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const input: AuditRequestBody = await req.json()

  if (!input.pageUrl || !isValidUrl(input.pageUrl)) {
    return NextResponse.json({ error: 'A valid page URL is required.' }, { status: 400 })
  }

  // --- Resolve client record for auto-integration pulls ---
  let clientRecord: any = null
  if (input.clientId) {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .eq('id', input.clientId)
      .single()
    clientRecord = data
  }

  // --- Resolve the audit row ---
  let auditRowId: string
  let isResubmission = false

  if (input.auditId) {
    const { data: existing } = await supabase
      .from('audits')
      .select('id, status, created_by, scraped_content, screenshot_desktop_url, screenshot_mobile_url')
      .eq('id', input.auditId)
      .eq('created_by', user.id)
      .single()

    if (!existing) {
      return NextResponse.json({ error: 'Audit not found.' }, { status: 404 })
    }
    if (existing.status !== 'needs_manual_input') {
      return NextResponse.json({ error: 'This audit is not awaiting manual input.' }, { status: 400 })
    }

    auditRowId = existing.id
    isResubmission = true
  } else {
    const { allowed, resetAt } = await checkRateLimit(auditRateLimit, user.id)
    if (!allowed) {
      return NextResponse.json(
        { error: `Rate limit reached. Try again after ${new Date(resetAt).toLocaleTimeString()}.` },
        { status: 429 }
      )
    }

    const { data: auditRow, error: insertError } = await supabase
      .from('audits')
      .insert({
        client_id: input.clientId || null,
        client_name: input.clientName,
        page_url: input.pageUrl,
        page_type: input.pageType,
        business_goal: input.businessGoal,
        input_data: input,
        status: 'running',
        created_by: user.id
      })
      .select()
      .single()

    if (insertError || !auditRow) {
      console.error('Failed to create audit row:', insertError)
      return NextResponse.json({ error: 'Could not start audit — database error.' }, { status: 500 })
    }
    auditRowId = auditRow.id
  }

  try {
    // --- HTML: manual paste wins; otherwise auto-fetch ---
    let scrapeResult: ScrapeResult
    if (input.manualHtml) {
      scrapeResult = { success: true, content: parseHtml(input.manualHtml, input.pageUrl) }
    } else {
      scrapeResult = await scrapePage(input.pageUrl)
    }

    // --- Screenshots ---
    const autoViewportsNeeded: ('desktop' | 'mobile')[] = []
    if (!input.manualScreenshotDesktop) autoViewportsNeeded.push('desktop')
    if (!input.manualScreenshotMobile) autoViewportsNeeded.push('mobile')

    let screenshotResult: ScreenshotResult = { success: false, shots: [], errors: {} }
    if (autoViewportsNeeded.length > 0) {
      screenshotResult = await captureScreenshots(input.pageUrl, autoViewportsNeeded)
    }

    if (input.manualScreenshotDesktop) {
      screenshotResult.shots.push({
        viewport: 'desktop', width: 1440, height: 900,
        base64: stripDataPrefix(input.manualScreenshotDesktop)
      })
    }
    if (input.manualScreenshotMobile) {
      screenshotResult.shots.push({
        viewport: 'mobile', width: 375, height: 812,
        base64: stripDataPrefix(input.manualScreenshotMobile)
      })
    }
    screenshotResult.success = screenshotResult.shots.length > 0

    // --- Confidence gate ---
    const confidence = assessConfidence(scrapeResult, screenshotResult)
    if (input.manualHtml) confidence.htmlOk = true
    if (input.manualScreenshotDesktop) confidence.desktopOk = true
    if (input.manualScreenshotMobile) confidence.mobileOk = true

    if (!isFullyConfident(confidence)) {
      await supabase
        .from('audits')
        .update({
          scraped_content: scrapeResult.success ? scrapeResult.content : { error: scrapeResult.error },
          status: 'needs_manual_input',
          input_data: input
        })
        .eq('id', auditRowId)

      return NextResponse.json({
        auditId: auditRowId,
        status: 'needs_manual_input',
        needsManualHtml: !confidence.htmlOk,
        needsManualDesktop: !confidence.desktopOk,
        needsManualMobile: !confidence.mobileOk,
        reasons: confidence.reasons
      })
    }

    // --- Fully confident — pull all data sources concurrently ---
    const [screenshotUrls, pagespeed, ga4Data, clarityResult] = await Promise.all([
      // Upload screenshots to Supabase Storage
      screenshotResult.shots.length > 0
        ? uploadScreenshots(supabase, auditRowId, screenshotResult.shots)
        : Promise.resolve({} as { desktop?: string; mobile?: string }),

      // PageSpeed Insights
      fetchPageSpeedBoth(input.pageUrl),

      // GA4 live pull (if client has ga4_property_id configured)
      clientRecord?.ga4_property_id
        ? fetchGA4AuditData(clientRecord.ga4_property_id, input.pageUrl)
        : Promise.resolve(null as GA4AuditData | null),

      // Clarity live pull (if client has clarity credentials configured)
      clientRecord?.clarity_project_id && clientRecord?.clarity_api_token
        ? fetchClarityData(clientRecord.clarity_project_id, clientRecord.clarity_api_token, input.pageUrl)
        : Promise.resolve(null as ClarityResult | null)
    ])

    const captureMode = input.manualHtml || input.manualScreenshotDesktop || input.manualScreenshotMobile
      ? (isResubmission ? 'mixed' : 'manual')
      : 'auto'

    // Build data sources metadata for the audit record
    const dataSources = {
      scrape: scrapeResult.success ? 'success' : 'failed',
      screenshots: screenshotResult.success ? screenshotResult.shots.map(s => s.viewport) : [],
      pagespeed: pagespeed.desktop.success || pagespeed.mobile.success ? 'success' : 'failed',
      ga4: ga4Data?.success ? 'live' : (ga4Data ? 'failed' : 'not_configured'),
      clarity: clarityResult?.success ? 'live' : (clarityResult ? 'failed' : 'not_configured'),
      captureMode
    }

    // --- Run the Fischer audit with ALL available data ---
    const result = await runFischerAudit(
      input,
      scrapeResult.success ? scrapeResult.content! : null,
      scrapeResult.error,
      screenshotResult.shots.map(s => ({ viewport: s.viewport, base64: s.base64 })),
      pagespeed,
      ga4Data || undefined,
      clarityResult?.success && clarityResult.data
        ? { data: clarityResult.data, isPageLevel: clarityResult.data.totalSessions > 0 }
        : undefined,
      clientRecord?.industry,
      clientRecord?.currency
    )

    await supabase
      .from('audits')
      .update({
        scraped_content: scrapeResult.success ? scrapeResult.content : { error: scrapeResult.error },
        screenshot_desktop_url: screenshotUrls.desktop ?? null,
        screenshot_mobile_url: screenshotUrls.mobile ?? null,
        pagespeed_desktop: pagespeed.desktop,
        pagespeed_mobile: pagespeed.mobile,
        ga4_data: ga4Data || null,
        clarity_data: clarityResult?.success ? clarityResult.data : null,
        capture_metadata: dataSources,
        output: result,
        fischer_score: result.fischerScore,
        status: 'complete',
        completed_at: new Date().toISOString()
      })
      .eq('id', auditRowId)

    return NextResponse.json({
      auditId: auditRowId,
      captureMode,
      status: 'complete',
      dataSources,
      scrapeSucceeded: scrapeResult.success,
      screenshotsSucceeded: screenshotResult.success,
      screenshotUrls,
      pagespeed,
      ga4Data: ga4Data?.success ? ga4Data : undefined,
      clarityData: clarityResult?.success ? clarityResult.data : undefined,
      result
    })
  } catch (err) {
    console.error('Fischer audit error:', err)
    await supabase
      .from('audits')
      .update({
        status: 'failed',
        error_message: err instanceof Error ? err.message : 'Unknown error'
      })
      .eq('id', auditRowId)

    return NextResponse.json(
      { error: 'Fischer encountered an error running this audit. Please try again.', auditId: auditRowId },
      { status: 500 }
    )
  }
}

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function stripDataPrefix(base64: string): string {
  const commaIndex = base64.indexOf(',')
  return base64.startsWith('data:') && commaIndex !== -1 ? base64.slice(commaIndex + 1) : base64
}

async function uploadScreenshots(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  auditId: string,
  shots: ViewportShot[]
): Promise<{ desktop?: string; mobile?: string }> {
  const urls: { desktop?: string; mobile?: string } = {}

  for (const shot of shots) {
    const path = `${auditId}/${shot.viewport}.jpg`
    const buffer = Buffer.from(shot.base64, 'base64')

    const { error } = await supabase.storage
      .from('fischer-screenshots')
      .upload(path, buffer, { contentType: 'image/jpeg', upsert: true })

    if (error) {
      console.error(`Failed to upload ${shot.viewport} screenshot:`, error)
      continue
    }

    const { data } = supabase.storage.from('fischer-screenshots').getPublicUrl(path)
    urls[shot.viewport] = data.publicUrl
  }

  return urls
}
