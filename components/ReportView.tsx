import type { MonthlyReport, KpiValue } from '@/lib/report'

/**
 * The client-facing monthly CRO report. Server-rendered, no client JS, and
 * print-ready (the PDF export prints this exact page).
 */

const C = {
  ink: '#0E1A2B', muted: '#5B6B80', line: '#E3E8EF', bg: '#F6F8FB', card: '#FFFFFF',
  // Brand colours come from agency settings via CSS variables on the report root
  navy: 'var(--rv-navy, #0B1F3A)', accent: 'var(--rv-accent, #C98A00)', good: '#0F8A5F', bad: '#C2412D', neutral: '#6B7A90',
  high: '#C2412D', medium: '#D97706', low: '#A3A3A3'
}

const fmtNum = (n: number | null | undefined, dp = 0) =>
  n == null ? '—' : n.toLocaleString('en-ZA', { maximumFractionDigits: dp, minimumFractionDigits: dp })

const fmtMoney = (n: number | null | undefined, currency: string) =>
  n == null || n === 0 ? '—' : `${currency === 'ZAR' ? 'R' : currency + ' '}${Math.round(n).toLocaleString('en-ZA')}`

function Delta({ v, invert = false, unit = '%' }: { v: number | null; invert?: boolean; unit?: string }) {
  if (v == null) return <span style={{ color: C.neutral, fontSize: 12 }}>no comparison</span>
  const up = v > 0
  const good = invert ? !up : up
  const color = Math.abs(v) < 0.5 ? C.neutral : good ? C.good : C.bad
  return <span style={{ color, fontSize: 12, fontWeight: 600 }}>{up ? '▲' : v < 0 ? '▼' : '■'} {Math.abs(v).toFixed(1)}{unit}</span>
}

function Kpi({ label, k, format, invert, hint }: { label: string; k: KpiValue; format: (n: number | null) => string; invert?: boolean; hint?: string }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: '14px 16px', breakInside: 'avoid' }}>
      <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: C.muted, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, margin: '6px 0 2px', fontVariantNumeric: 'tabular-nums' }}>{format(k.current)}</div>
      <div><Delta v={k.changePct} invert={invert} /> <span style={{ fontSize: 12, color: C.muted }}>vs {k.previous == null ? '—' : format(k.previous)}</span></div>
      {hint && <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

function Bars({ data, label, format }: { data: { label: string; value: number | null }[]; label: string; format: (n: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.value ?? 0))
  const w = 520, h = 150, pad = 24, bw = (w - pad * 2) / data.length
  return (
    <figure style={{ margin: 0 }}>
      <figcaption style={{ fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6 }}>{label}</figcaption>
      <svg viewBox={`0 0 ${w} ${h + 30}`} width="100%" role="img" aria-label={label}>
        <line x1={pad} y1={h} x2={w - pad} y2={h} stroke={C.line} />
        {data.map((d, i) => {
          const bh = d.value == null ? 0 : Math.max(2, (d.value / max) * (h - 20))
          const x = pad + i * bw + bw * 0.18
          const last = i === data.length - 1
          return (
            <g key={i}>
              {d.value != null && <rect x={x} y={h - bh} width={bw * 0.64} height={bh} rx={3} style={{ fill: last ? C.navy : '#AFC0D6' }} />}
              <text x={x + bw * 0.32} y={h - bh - 6} textAnchor="middle" fontSize="11" fill={C.ink}>{d.value == null ? '' : format(d.value)}</text>
              <text x={x + bw * 0.32} y={h + 16} textAnchor="middle" fontSize="11" fill={C.muted}>{d.label}</text>
            </g>
          )
        })}
      </svg>
    </figure>
  )
}

function Section({ title, kicker, children }: { title: string; kicker?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 36 }}>
      {kicker && <div style={{ fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', color: C.accent, fontWeight: 700 }}>{kicker}</div>}
      <h2 style={{ fontSize: 22, margin: '4px 0 14px', color: C.navy }}>{title}</h2>
      {children}
    </section>
  )
}

const statusLabel: Record<string, { text: string; color: string }> = {
  resolved: { text: 'Resolved', color: C.good }, improved: { text: 'Improved', color: C.good },
  still_present: { text: 'Still open', color: C.medium }, worse: { text: 'Worse', color: C.bad },
  cannot_verify: { text: 'Not verifiable', color: C.neutral }
}

export function ReportView({ report: r, print }: { report: MonthlyReport; print?: boolean }) {
  const cur = r.client.currency
  const pct = (n: number | null) => n == null ? '—' : `${n.toFixed(2)}%`
  const k = r.kpis
  const headline: string[] = []
  if (k.conversionRate.current != null) {
    headline.push(`Conversion rate was ${k.conversionRate.current.toFixed(2)}%${k.conversionRate.changePct != null ? ` (${k.conversionRate.changePct > 0 ? 'up' : 'down'} ${Math.abs(k.conversionRate.changePct).toFixed(1)}% on ${r.previousPeriodLabel})` : ''}`)
  }
  if (k.conversions.current != null) headline.push(`${fmtNum(k.conversions.current)} conversions from ${fmtNum(k.sessions.current)} sessions`)
  headline.push(`${r.changes.length} change${r.changes.length === 1 ? '' : 's'} made`)
  if (r.tests.length) headline.push(`${r.tests.length} A/B test${r.tests.length === 1 ? '' : 's'} live or concluded`)

  return (
    <div className="rv-outer" style={{ ['--rv-navy' as any]: r.branding.primaryColor, ['--rv-accent' as any]: r.branding.accentColor,  background: print ? '#fff' : C.bg, color: C.ink, minHeight: '100vh', fontFamily: "'Space Grotesk', system-ui, sans-serif", padding: print ? 0 : '32px 16px' }}>
      <style>{`
        @media print { .no-print { display: none !important } section { break-inside: auto } }
        .rv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px }
        .rv-sheet { padding: 36px 40px }
        @media (max-width: 640px) { .rv-sheet { padding: 20px 16px } .rv-outer { padding: 0 !important } }
        .rv-table { min-width: 560px }
        .rv-two { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px }
        .rv-table { width: 100%; border-collapse: collapse; font-size: 13px }
        .rv-table th { text-align: left; color: ${C.muted}; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; padding: 8px; border-bottom: 1px solid ${C.line} }
        .rv-table td { padding: 10px 8px; border-bottom: 1px solid ${C.line}; vertical-align: top }
        .rv-scroll { overflow-x: auto }
      `}</style>
      <div className={print ? '' : 'rv-sheet'} style={{ maxWidth: 980, margin: '0 auto', background: C.card, borderRadius: print ? 0 : 14, ...(print ? { padding: '8px 4px' } : {}), boxShadow: print ? 'none' : '0 1px 3px rgba(14,26,43,.08)' }}>

        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', borderBottom: `3px solid ${C.navy}`, paddingBottom: 18 }}>
          <div>
            <div style={{ fontSize: 12, letterSpacing: 3, textTransform: 'uppercase', color: C.accent, fontWeight: 700 }}>Conversion Report</div>
            <h1 style={{ fontSize: 32, margin: '6px 0 4px', color: C.navy }}>{r.client.name}</h1>
            <div style={{ color: C.muted }}>{r.periodLabel} · prepared by {r.branding.agencyName}{r.branding.showFischerName ? ' with Fischer' : ''}</div>
          </div>
          {r.client.logoUrl && <img src={r.client.logoUrl} alt={`${r.client.name} logo`} style={{ maxHeight: 56, maxWidth: 180 }} />}
        </header>

        <p style={{ fontSize: 16, lineHeight: 1.6, marginTop: 18 }}>{headline.join(' · ')}.</p>

        <Section title="This month at a glance" kicker={`${r.periodLabel} vs ${r.previousPeriodLabel}`}>
          <div className="rv-grid">
            {r.integrations.ga4 && <>
              <Kpi label="Conversion rate" k={k.conversionRate} format={pct} />
              <Kpi label="Conversions" k={k.conversions} format={n => fmtNum(n)} />
              <Kpi label="Sessions" k={k.sessions} format={n => fmtNum(n)} />
              {k.revenue.current != null && <Kpi label="Revenue" k={k.revenue} format={n => fmtMoney(n, cur)} />}
              <Kpi label="Engagement rate" k={k.engagementRate} format={n => n == null ? '—' : `${n.toFixed(1)}%`} />
            </>}
            <Kpi label="Fischer Score (avg)" k={k.avgFischerScore} format={n => n == null ? '—' : `${n}/100`} hint="Conversion health of audited pages" />
            {r.integrations.clarity && <>
              <Kpi label="Rage-click sessions" k={k.rageClickRate} format={n => n == null ? '—' : `${n.toFixed(1)}%`} invert hint="Lower is better" />
              <Kpi label="Dead-click sessions" k={k.deadClickRate} format={n => n == null ? '—' : `${n.toFixed(1)}%`} invert hint="Lower is better" />
              <Kpi label="Avg scroll depth" k={k.scrollDepth} format={n => n == null ? '—' : `${Math.round(n)}%`} />
            </>}
          </div>
        </Section>

        {r.benchmark && r.benchmark.clientRate != null && (
          <p style={{ fontSize: 14, background: C.bg, padding: '10px 12px', borderRadius: 8, marginTop: 14 }}>
            <strong>Industry comparison:</strong> over {r.benchmark.months[0]} – {r.benchmark.months[r.benchmark.months.length - 1]} your conversion rate was {r.benchmark.clientRate.toFixed(2)}%, against a median of {r.benchmark.median.toFixed(2)}% across {r.benchmark.clients} {r.benchmark.industry} sites we work with ({r.benchmark.position}).
            {r.benchmark.devices.filter(d => d.clientRate != null).map(d => ` ${d.device[0].toUpperCase() + d.device.slice(1)}: ${d.clientRate!.toFixed(2)}% vs ${d.median.toFixed(2)}%.`).join('')}
          </p>
        )}

        {r.trend.some(t => t.sessions != null || t.avgFischerScore != null) && (
          <Section title="Six-month trend" kicker="Progress">
            <div className="rv-two">
              {r.trend.some(t => t.conversionRate != null) && <Bars label="Conversion rate (%)" data={r.trend.map(t => ({ label: t.label, value: t.conversionRate }))} format={n => n.toFixed(2)} />}
              {r.trend.some(t => t.conversions != null) && <Bars label="Conversions" data={r.trend.map(t => ({ label: t.label, value: t.conversions }))} format={n => fmtNum(n)} />}
              {r.trend.some(t => t.avgFischerScore != null) && <Bars label="Fischer Score" data={r.trend.map(t => ({ label: t.label, value: t.avgFischerScore }))} format={n => String(n)} />}
              {r.trend.some(t => t.sessions != null) && <Bars label="Sessions" data={r.trend.map(t => ({ label: t.label, value: t.sessions }))} format={n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)} />}
            </div>
          </Section>
        )}

        {r.leaks && r.leaks.topPages.length > 0 && (
          <Section title="Where revenue is leaking" kicker="Opportunity map">
            <p style={{ lineHeight: 1.6, marginTop: 0 }}>
              {r.leaks.hasValue
                ? <>Bringing the weakest pages up to the site&apos;s own average ({r.leaks.siteRate.toFixed(2)}%) — closing half of each gap — is worth about <strong>{fmtMoney(r.leaks.recoverableMonthly, cur)} per month</strong>.</>
                : <>These pages convert below the site&apos;s own average of {r.leaks.siteRate.toFixed(2)}%. Set a value per conversion to see the rand value.</>}
              {r.leaks.byDevice[0] && <> {r.leaks.byDevice[0].share.toFixed(0)}% of the gap is on <strong>{r.leaks.byDevice[0].device}</strong>.</>}
            </p>
            <div className="rv-scroll"><table className="rv-table">
              <thead><tr><th>Page</th><th>Conv. rate</th><th>Share of gap</th><th>Worst on</th>{r.leaks.hasValue && <th>Recoverable / month</th>}</tr></thead>
              <tbody>{r.leaks.topPages.map(p => (
                <tr key={p.page}>
                  <td style={{ wordBreak: 'break-all' }}>{p.page}</td>
                  <td>{p.conversionRate.toFixed(2)}%</td>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 80, height: 6, background: C.line, borderRadius: 3 }}><div style={{ width: `${Math.min(100, p.share)}%`, height: 6, background: C.bad, borderRadius: 3 }} /></div>
                      {p.share.toFixed(0)}%
                    </div>
                  </td>
                  <td>{p.worstDevice ?? '—'}</td>
                  {r.leaks!.hasValue && <td>{fmtMoney(p.recoverableMonthly, cur)}</td>}
                </tr>))}
              </tbody></table></div>
            {r.leaks.funnel && (
              <div style={{ margin: '16px 0', breakInside: 'avoid' }}>
                <div style={{ fontSize: 12, color: C.muted, fontWeight: 600, marginBottom: 6 }}>{r.leaks.funnel.kind === 'ecommerce' ? 'CHECKOUT FUNNEL' : 'LEAD FUNNEL'} — users reaching each step</div>
                {r.leaks.funnel.steps.map(s => {
                  const max = Math.max(1, ...r.leaks!.funnel!.steps.map(x => x.users))
                  return (
                    <div key={s.event} style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0', fontSize: 13 }}>
                      <div style={{ width: 140 }}>{s.label}</div>
                      <div style={{ flex: 1, background: C.bg, borderRadius: 3 }}><div style={{ width: `${(s.users / max) * 100}%`, minWidth: 2, height: 14, background: C.navy, borderRadius: 3 }} /></div>
                      <div style={{ width: 150, textAlign: 'right' }}>{fmtNum(s.users)}{s.rateFromPrevious != null && <span style={{ color: C.muted }}> · {s.rateFromPrevious}%</span>}</div>
                    </div>)
                })}
                {r.leaks.funnel.worstStep && <p style={{ fontSize: 14, margin: '8px 0 0' }}><strong>Biggest drop-off:</strong> {r.leaks.funnel.worstStep.from} → {r.leaks.funnel.worstStep.to}, where only {r.leaks.funnel.worstStep.rate}% continue.</p>}
              </div>
            )}
            {r.leaks.mobileGap && (
              <p style={{ fontSize: 14, background: C.bg, padding: '10px 12px', borderRadius: 8 }}>
                <strong>Mobile gap:</strong> mobile converts at {r.leaks.mobileGap.mobileRate.toFixed(2)}% vs {r.leaks.mobileGap.desktopRate.toFixed(2)}% on desktop.
                Reaching {r.leaks.mobileGap.targetRate.toFixed(2)}% on mobile would add ~{fmtNum(r.leaks.mobileGap.lostConversions)} conversions per period{r.leaks.hasValue ? ` (≈${fmtMoney(r.leaks.mobileGap.value, cur)}/month at half the gap)` : ''}.
              </p>
            )}
            {r.leaks.adSpend && r.leaks.adSpend.total > 0 && r.leaks.adSpend.onBelowAveragePages > 0 && (
              <p style={{ fontSize: 14, background: C.bg, padding: '10px 12px', borderRadius: 8 }}>
                <strong>Ad spend:</strong> {fmtMoney(r.leaks.adSpend.onBelowAveragePages, cur)} of {fmtMoney(r.leaks.adSpend.total, cur)} Google Ads spend ({Math.round((r.leaks.adSpend.onBelowAveragePages / r.leaks.adSpend.total) * 100)}%) went to pages converting below your site average. Fixing those pages makes the same budget produce more leads.
              </p>
            )}
            {r.leaks.paid.length > 0 && (
              <p style={{ fontSize: 14, background: C.bg, padding: '10px 12px', borderRadius: 8 }}>
                <strong>Paid traffic on weak pages:</strong> {r.leaks.paid.map(p => `${p.channel} → ${p.page} converts at ${p.conversionRate.toFixed(2)}%`).join('; ')} — below the site average of {r.leaks.paid[0].siteRate.toFixed(2)}%. This is ad spend that isn&apos;t converting.
              </p>
            )}
          </Section>
        )}

        {r.leadQuality && (
          <Section title="Lead quality" kicker="From your CRM">
            <div className="rv-grid" style={{ marginBottom: 14 }}>
              <div><div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>LEADS</div><div style={{ fontSize: 24, fontWeight: 700 }}>{fmtNum(r.leadQuality.totals.leads)}</div></div>
              <div><div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>QUALIFIED</div><div style={{ fontSize: 24, fontWeight: 700 }}>{r.leadQuality.totals.qualifiedRate}%</div></div>
              <div><div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>WON</div><div style={{ fontSize: 24, fontWeight: 700 }}>{fmtNum(r.leadQuality.totals.won)}</div></div>
              {r.leadQuality.totals.revenue > 0 && <div><div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>REVENUE WON</div><div style={{ fontSize: 24, fontWeight: 700 }}>{fmtMoney(r.leadQuality.totals.revenue, cur)}</div></div>}
            </div>
            <div className="rv-scroll"><table className="rv-table">
              <thead><tr><th>Source</th><th>Leads</th><th>Qualified</th><th>Won</th>{r.leadQuality.totals.revenue > 0 && <th>Revenue / lead</th>}</tr></thead>
              <tbody>{r.leadQuality.bySource.slice(0, 6).map(s => (
                <tr key={s.key}><td>{s.key}</td><td>{fmtNum(s.leads)}</td><td>{s.qualifiedRate}%</td><td>{fmtNum(s.won)}</td>{r.leadQuality!.totals.revenue > 0 && <td>{fmtMoney(s.revenuePerLead, cur)}</td>}</tr>))}
              </tbody></table></div>
            {r.leadQuality.insights.length > 0 && <ul style={{ fontSize: 14, paddingLeft: 18 }}>{r.leadQuality.insights.slice(0, 4).map((x, i) => <li key={i}>{x}</li>)}</ul>}
          </Section>
        )}

        <Section title="Changes made and their impact" kicker="What we did">
          {r.changes.length === 0 ? <p style={{ color: C.muted }}>No changes were logged this month.</p> : (
            <div className="rv-scroll"><table className="rv-table">
              <thead><tr><th>Date</th><th>Change</th><th>Conversion rate before → after</th><th>Change</th></tr></thead>
              <tbody>{r.changes.map((ch, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{ch.date}</td>
                  <td><strong>{ch.title}</strong>{ch.description && <div style={{ color: C.muted, marginTop: 2 }}>{ch.description}</div>}
                    <div style={{ color: C.muted, fontSize: 11, marginTop: 2 }}>{ch.source === 'detected' ? 'Detected by Fischer' : ch.source === 'test' ? 'A/B test' : ch.source === 'backlog' ? 'Shipped from roadmap' : 'Logged'}{ch.pageUrl ? ` · ${ch.pageUrl.replace(/^https?:\/\//, '')}` : ''}</div></td>
                  <td style={{ whiteSpace: 'nowrap' }}>{ch.impact ? `${ch.impact.beforeMetrics.conversionRate.toFixed(2)}% → ${ch.impact.afterMetrics.conversionRate.toFixed(2)}%` : <span style={{ color: C.muted }}>Measuring…</span>}
                    {ch.impact && !ch.impact.afterComplete && <div style={{ fontSize: 11, color: C.muted }}>partial window</div>}</td>
                  <td>{ch.impact ? <Delta v={ch.impact.conversionRateChangePct} /> : null}</td>
                </tr>))}
              </tbody></table></div>
          )}
        </Section>

        {r.tests.length > 0 && (
          <Section title="A/B tests" kicker="Controlled experiments">
            {r.tests.map(t => (
              <div key={t.id} style={{ border: `1px solid ${C.line}`, borderRadius: 10, padding: 16, marginBottom: 12, breakInside: 'avoid' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <strong>{t.name}</strong>
                  <span style={{ fontSize: 12, fontWeight: 700, color: t.winner === 'variant' ? C.good : t.winner === 'control' ? C.bad : C.neutral, textTransform: 'uppercase' }}>
                    {t.status === 'running' ? 'Running' : t.winner === 'variant' ? 'Variant won' : t.winner === 'control' ? 'Original won' : 'No clear winner'}
                  </span>
                </div>
                <div style={{ color: C.muted, fontSize: 13, margin: '6px 0 10px' }}>{t.hypothesis}</div>
                {t.stats ? (
                  <div className="rv-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))' }}>
                    <div><div style={{ fontSize: 11, color: C.muted }}>ORIGINAL</div><div style={{ fontSize: 18, fontWeight: 700 }}>{t.stats.controlRate.toFixed(2)}%</div></div>
                    <div><div style={{ fontSize: 11, color: C.muted }}>VARIANT</div><div style={{ fontSize: 18, fontWeight: 700 }}>{t.stats.variantRate.toFixed(2)}%</div></div>
                    <div><div style={{ fontSize: 11, color: C.muted }}>LIFT</div><div style={{ fontSize: 18, fontWeight: 700 }}><Delta v={t.stats.relativeLift} /></div></div>
                    <div><div style={{ fontSize: 11, color: C.muted }}>CONFIDENCE</div><div style={{ fontSize: 18, fontWeight: 700 }}>{t.stats.confidence.toFixed(1)}%</div></div>
                  </div>
                ) : <div style={{ fontSize: 13, color: C.muted }}>Collecting data{t.startDate ? ` since ${t.startDate}` : ''}.</div>}
                {t.resultSummary && <div style={{ fontSize: 13, marginTop: 10 }}>{t.resultSummary}</div>}
              </div>
            ))}
          </Section>
        )}

        {r.pages.length > 0 && (
          <Section title="Page audits" kicker="What Fischer found">
            {r.pages.map(p => (
              <article key={p.auditId} style={{ borderTop: `1px solid ${C.line}`, paddingTop: 18, marginTop: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
                  <h3 style={{ margin: 0, fontSize: 17, wordBreak: 'break-all' }}>{p.pageUrl.replace(/^https?:\/\//, '')}</h3>
                  <div style={{ fontSize: 13, color: C.muted }}>Audited {p.auditDate.slice(0, 10)}</div>
                </div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '14px 0' }}>
                  <div>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>FISCHER SCORE</div>
                    <div style={{ fontSize: 34, fontWeight: 700, color: C.navy }}>{p.fischerScore}<span style={{ fontSize: 15, color: C.muted }}>/100</span></div>
                    {p.previousScore != null && <Delta v={p.fischerScore - p.previousScore} unit=" pts" />}
                  </div>
                  {p.ga4 && <div>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>PAGE CONVERSION RATE</div>
                    <div style={{ fontSize: 34, fontWeight: 700, color: C.navy }}>{p.ga4.conversionRate.toFixed(2)}%</div>
                    {p.ga4.prevConversionRate != null && <Delta v={p.ga4.prevConversionRate ? ((p.ga4.conversionRate - p.ga4.prevConversionRate) / p.ga4.prevConversionRate) * 100 : null} />}
                  </div>}
                  {p.followUp.length > 0 && <div>
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>LAST AUDIT&apos;S ISSUES FIXED</div>
                    <div style={{ fontSize: 34, fontWeight: 700, color: C.navy }}>{p.resolvedCount}<span style={{ fontSize: 15, color: C.muted }}>/{p.followUp.length}</span></div>
                  </div>}
                </div>
                {p.scoreBreakdown && (
                  <div className="rv-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', marginBottom: 14 }}>
                    {Object.entries({ 'Value proposition': p.scoreBreakdown.valueProposition, 'Calls to action': p.scoreBreakdown.callsToAction, Trust: p.scoreBreakdown.trust, 'Low friction': p.scoreBreakdown.friction, Mobile: p.scoreBreakdown.mobile, Performance: p.scoreBreakdown.performance }).map(([label, v]) => (
                      <div key={label}>
                        <div style={{ fontSize: 11, color: C.muted, display: 'flex', justifyContent: 'space-between' }}><span>{label}</span><span>{v}</span></div>
                        <div style={{ height: 6, background: C.line, borderRadius: 3, marginTop: 4 }}><div style={{ width: `${v}%`, height: 6, borderRadius: 3, background: v >= 70 ? C.good : v >= 45 ? C.medium : C.bad }} /></div>
                      </div>
                    ))}
                  </div>
                )}
                <p style={{ lineHeight: 1.6 }}>{p.summary}</p>
                {p.pageChanges && <p style={{ fontSize: 13, color: C.muted }}>Page changes since last audit: {p.pageChanges}</p>}
                {(p.screenshotDesktop || p.screenshotMobile) && (
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', margin: '12px 0', breakInside: 'avoid' }}>
                    {p.screenshotDesktop && <img src={p.screenshotDesktop} alt="Desktop view of the page, above the fold" style={{ width: '72%', aspectRatio: '1440 / 900', objectFit: 'cover', objectPosition: 'top', border: `1px solid ${C.line}`, borderRadius: 6 }} />}
                    {p.screenshotMobile && <img src={p.screenshotMobile} alt="Mobile view of the page, above the fold" style={{ width: '22%', aspectRatio: '390 / 844', objectFit: 'cover', objectPosition: 'top', border: `1px solid ${C.line}`, borderRadius: 6 }} />}
                  </div>
                )}
                {p.followUp.length > 0 && (
                  <>
                    <h4 style={{ margin: '16px 0 8px' }}>Progress on last audit&apos;s issues</h4>
                    <ul style={{ paddingLeft: 18, margin: 0 }}>
                      {p.followUp.map((f, i) => (
                        <li key={i} style={{ marginBottom: 6, fontSize: 14 }}>
                          <span style={{ color: statusLabel[f.status]?.color, fontWeight: 700 }}>{statusLabel[f.status]?.text ?? f.status}:</span> {f.previousTitle}
                          <span style={{ color: C.muted }}> — {f.evidence}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {p.topFindings.length > 0 && (
                  <>
                    <h4 style={{ margin: '18px 0 8px' }}>Top opportunities</h4>
                    {p.topFindings.map((f, i) => (
                      <div key={i} style={{ borderLeft: `3px solid ${C[f.severity]}`, padding: '6px 12px', margin: '8px 0', breakInside: 'avoid' }}>
                        <div style={{ fontWeight: 700 }}>{f.title} <span style={{ fontSize: 11, color: C[f.severity], textTransform: 'uppercase' }}>{f.severity}</span></div>
                        <div style={{ fontSize: 13, color: C.muted, margin: '3px 0' }}>Evidence: {f.evidence}</div>
                        <div style={{ fontSize: 14 }}><strong>Fix:</strong> {f.fix}</div>
                      </div>
                    ))}
                  </>
                )}
                {p.strengths.length > 0 && (
                  <p style={{ fontSize: 13, color: C.muted }}><strong style={{ color: C.good }}>Working well:</strong> {p.strengths.map(s => s.title).join(' · ')}</p>
                )}
                {p.revenueImpact && p.revenueImpact.currentMonthlyRevenue > 0 && (
                  <p style={{ fontSize: 14, background: C.bg, padding: '10px 12px', borderRadius: 8 }}>
                    <strong>Opportunity:</strong> fixing these is estimated to add {fmtMoney(p.revenueImpact.conservativeAdditionalRevenue, cur)}–{fmtMoney(p.revenueImpact.realisticAdditionalRevenue, cur)} per month
                    ({p.revenueImpact.conservativeLiftPct}–{p.revenueImpact.realisticLiftPct}% conversion lift on {fmtNum(p.revenueImpact.monthlyTraffic)} monthly sessions{p.revenueImpact.basis === 'manual' ? ', from figures you supplied' : ', from GA4'}).
                  </p>
                )}
              </article>
            ))}
          </Section>
        )}

        {r.nextMonth.length > 0 && (
          <Section title="Next month" kicker="The plan">
            <ol style={{ paddingLeft: 18, lineHeight: 1.7 }}>{r.nextMonth.map((n, i) => <li key={i}>{n}</li>)}</ol>
          </Section>
        )}

        {r.dataNotes.length > 0 && (
          <section style={{ marginTop: 32, fontSize: 12, color: C.muted, borderTop: `1px solid ${C.line}`, paddingTop: 12 }}>
            <strong>About this data</strong>
            <ul style={{ paddingLeft: 18 }}>{r.dataNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>
          </section>
        )}

        <footer style={{ marginTop: 24, fontSize: 12, color: C.muted, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{r.branding.logoUrl && <img src={r.branding.logoUrl} alt={r.branding.agencyName} style={{ maxHeight: 22 }} />}{r.branding.agencyName}{r.branding.footer ? ` · ${r.branding.footer}` : ''}</span>
          <span>{r.client.contactName ? `Questions? ${r.client.contactName}${r.client.contactEmail ? ` · ${r.client.contactEmail}` : ''}` : `Generated ${r.generatedAt.slice(0, 10)}`}</span>
        </footer>
      </div>
    </div>
  )
}
