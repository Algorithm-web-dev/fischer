/**
 * Fischer staging smoke test — checks every external connection, then
 * (optionally) runs one real audit end to end.
 *
 *   npx tsx --env-file=.env.local scripts/smoke-test.ts
 *   npx tsx --env-file=.env.local scripts/smoke-test.ts --url=https://client.co.za/ --client=<client uuid> --audit
 *
 * --url     page to capture / audit (default https://example.com/)
 * --client  client id whose GA4 / Clarity / CRM settings to test
 * --audit   also run a full audit (costs one real Claude call, ~$0.20–0.60)
 *
 * Nothing is deleted. A test audit row is created only with --audit.
 * Locally, set CHROME_EXECUTABLE_PATH to your Chrome binary.
 */
import { z } from 'zod'
import { createSupabaseServiceClient } from '../lib/supabase'
import { structuredCall, FISCHER_MODEL, FISCHER_SCHEDULED_MODEL } from '../lib/llm'
import { capturePage } from '../lib/capture'
import { fetchPageSpeed } from '../lib/pagespeed'
import { fetchGA4AuditData, lastNDays } from '../lib/ga4-audit'
import { fetchGA4EventInventory } from '../lib/tracking'
import { fetchClarityExport } from '../lib/clarity'
import { runAuditPipeline } from '../lib/audit-pipeline'

const args = Object.fromEntries(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? 'true'] }))
const url = args.url || 'https://example.com/'
type Result = { check: string; ok: boolean | null; detail: string; ms: number }
const results: Result[] = []

async function check(name: string, fn: () => Promise<string>, optional = false) {
  const t = Date.now()
  try {
    const detail = await fn()
    results.push({ check: name, ok: true, detail, ms: Date.now() - t })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    results.push({ check: name, ok: optional && msg.startsWith('SKIP') ? null : false, detail: msg.replace(/^SKIP: /, ''), ms: Date.now() - t })
  }
  const r = results[results.length - 1]
  console.log(`${r.ok === true ? '✅' : r.ok === null ? '⏭ ' : '❌'} ${name.padEnd(34)} ${r.detail} (${(r.ms / 1000).toFixed(1)}s)`)
}

const skip = (why: string) => { throw new Error(`SKIP: ${why}`) }

async function main() {
  console.log(`Fischer smoke test — ${new Date().toISOString()}\n`)

  await check('Environment variables', async () => {
    const required = ['ANTHROPIC_API_KEY', 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET']
    const missing = required.filter(k => !process.env[k])
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
    const optional = ['GOOGLE_PAGESPEED_API_KEY', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'UPSTASH_REDIS_REST_URL', 'FISCHER_PUBLIC_URL', 'ALERT_WEBHOOK_URL', 'FISCHER_ENCRYPTION_KEY']
    const off = optional.filter(k => !process.env[k])
    return off.length ? `required set; not set: ${off.join(', ')}` : 'all set'
  })

  const sb = createSupabaseServiceClient()
  await check('Supabase tables (migrations)', async () => {
    const tables = ['clients', 'audits', 'backlog_items', 'test_briefs', 'tracked_pages', 'monthly_snapshots', 'clarity_daily', 'change_log',
      'report_shares', 'leak_analyses', 'journey_checks', 'alerts', 'leads', 'llm_usage', 'error_log']
    const missing: string[] = []
    for (const t of tables) {
      const { error } = await sb.from(t).select('*', { head: true, count: 'exact' }).limit(1)
      if (error && /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(error.message)) throw new Error(`cannot reach Supabase at ${process.env.NEXT_PUBLIC_SUPABASE_URL}: ${error.message}`)
      if (error) missing.push(`${t} (${error.message})`)
    }
    if (missing.length) throw new Error(`not found: ${missing.join('; ')} — run the migrations in supabase/migrations in order`)
    return `${tables.length} tables present`
  })

  await check('Supabase storage bucket', async () => {
    const { data, error } = await sb.storage.getBucket('fischer-screenshots')
    if (error || !data) throw new Error(error?.message || 'bucket fischer-screenshots missing (created by migration 0001)')
    return `fischer-screenshots (${data.public ? 'public' : 'private'})`
  })

  for (const model of Array.from(new Set([FISCHER_MODEL, FISCHER_SCHEDULED_MODEL]))) {
    await check(`Claude structured output: ${model}`, async () => {
      const r = await structuredCall({
        model, schema: z.object({ ok: z.boolean(), word: z.string() }), maxTokens: 2000, effort: 'low',
        system: 'You are a connectivity test.', content: 'Return ok=true and word="fischer".',
        track: { feature: 'smoke_test' }
      })
      if (!r.ok) throw new Error('unexpected output')
      return `ok (${r.word})`
    })
  }

  let captureOk = false
  await check(`Browser capture ${url}`, async () => {
    const c = await capturePage(url)
    captureOk = c.desktop.ok && c.mobile.ok
    if (!captureOk) throw new Error(`desktop: ${c.desktop.error ?? 'ok'}; mobile: ${c.mobile.error ?? 'ok'}`)
    return `${c.desktop.segments.length} desktop + ${c.mobile.segments.length} mobile sections, ${c.content?.wordCount ?? 0} words (${c.contentSource})`
  })

  await check('PageSpeed Insights', async () => {
    if (!process.env.GOOGLE_PAGESPEED_API_KEY) skip('GOOGLE_PAGESPEED_API_KEY not set')
    const r = await fetchPageSpeed(url, 'mobile')
    if (!r.success) throw new Error(r.error)
    return `mobile score ${r.performanceScore}`
  }, true)

  let client: any = null
  if (args.client) {
    const { data } = await sb.from('clients').select('*').eq('id', args.client).single()
    client = data
    await check('Client record', async () => { if (!client) throw new Error('client not found'); return client.name })
  }

  await check('GA4 (client property)', async () => {
    if (!client?.ga4_property_id) skip('pass --client=<id> with a GA4 property set')
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY not set')
    const r = await fetchGA4AuditData(client.ga4_property_id, { range: lastNDays(7), conversionEvent: client.ga4_conversion_event })
    if (!r.success) throw new Error(r.error)
    const events = await fetchGA4EventInventory(client.ga4_property_id)
    const keys = events.filter(e => e.isKeyEvent).map(e => e.name)
    return `${r.totals!.sessions} sessions / ${r.totals!.conversions} conversions in 7 days; key events: ${keys.join(', ') || 'NONE'}`
  }, true)

  await check('Clarity (client token)', async () => {
    if (!client?.clarity_api_token) skip('pass --client=<id> with a Clarity token set')
    const { decryptSecret } = await import('../lib/secrets')
    const r = await fetchClarityExport(decryptSecret(client.clarity_api_token), 1)
    if (!r.success) throw new Error(r.error)
    return `${r.metrics.length} metric groups (uses 1 of 10 daily requests)`
  }, true)

  if (args.audit) {
    await check('Full audit end to end', async () => {
      if (!captureOk) throw new Error('capture failed above — fix that first')
      const input = { clientId: client?.id, clientName: client?.name ?? 'Smoke test', pageUrl: url, pageType: 'Landing Page', businessGoal: 'Lead Generation' }
      const { data: row, error } = await sb.from('audits').insert({
        client_id: client?.id ?? null, client_name: input.clientName, page_url: url, page_type: input.pageType,
        business_goal: input.businessGoal, input_data: input, status: 'running', trigger: 'manual'
      }).select('id').single()
      if (error || !row) throw new Error(error?.message)
      const outcome = await runAuditPipeline({ supabase: sb, auditId: row.id, input, client })
      if (outcome.status !== 'complete') throw new Error(`needs manual input: ${JSON.stringify(outcome.confidence.reasons)}`)
      const { data: usage } = await sb.from('llm_usage').select('cost_usd').eq('audit_id', row.id)
      const cost = (usage ?? []).reduce((s, u) => s + Number(u.cost_usd), 0)
      const r = outcome.result
      return `score ${r.fischerScore}, ${r.frictionPoints.length} findings (+${r.unverifiedFindings.length} unverified), ${r.abTestHypotheses.length} tests, cost $${cost.toFixed(3)} — audit ${row.id}`
    })
  }

  const failed = results.filter(r => r.ok === false)
  console.log(`\n${results.filter(r => r.ok).length} passed, ${failed.length} failed, ${results.filter(r => r.ok === null).length} skipped`)
  process.exit(failed.length ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
