'use client'
import { useState } from 'react'
import type { AuditResult } from '@/lib/claude'

const INPUT_STYLE: React.CSSProperties = {
  width: '100%', padding: '12px 14px', background: '#0D1B2E',
  border: '1px solid #1E3A5F', borderRadius: '8px', color: '#FFFFFF',
  fontSize: '14px', outline: 'none', boxSizing: 'border-box'
}
const LABEL_STYLE: React.CSSProperties = {
  display: 'block', fontSize: '11px', color: '#7A9BBD',
  letterSpacing: '2px', marginBottom: '8px', fontWeight: 600
}
const CARD_STYLE: React.CSSProperties = {
  background: '#112240', border: '1px solid #1E3A5F',
  borderRadius: '12px', padding: '28px', marginBottom: '20px'
}

const SEVERITY_COLOR = { high: '#FF4757', medium: '#FF6B35', low: '#FFD700' }

export default function AuditPage() {
  const [form, setForm] = useState({
    clientName: '', pageUrl: '', pageType: 'Landing Page',
    businessGoal: 'Lead Generation', monthlyTraffic: '',
    currentConversionRate: '', avgOrderValue: '',
    deviceSplit: '60% Mobile / 40% Desktop',
    bounceRate: '', avgSessionDuration: '',
    topExitPages: '', additionalContext: ''
  })
  const [manualHtml, setManualHtml] = useState('')
  const [manualDesktopFile, setManualDesktopFile] = useState<string | null>(null)
  const [manualMobileFile, setManualMobileFile] = useState<string | null>(null)
  const [needsManualInput, setNeedsManualInput] = useState<{
    auditId: string
    needsManualHtml: boolean
    needsManualDesktop: boolean
    needsManualMobile: boolean
    reasons: { html?: string; desktop?: string; mobile?: string }
  } | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<AuditResult | null>(null)
  const [completedAuditId, setCompletedAuditId] = useState<string | null>(null)
  const [scrapeSucceeded, setScrapeSucceeded] = useState<boolean | null>(null)
  const [captureMode, setCaptureMode] = useState<string | null>(null)

  function updateForm(field: string, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  function handleFileUpload(file: File, setter: (b64: string) => void) {
    const reader = new FileReader()
    reader.onload = () => setter(reader.result as string)
    reader.readAsDataURL(file)
  }

  async function runAudit(e: React.FormEvent) {
    e.preventDefault()
    setRunning(true)
    setError('')
    setResult(null)

    try {
      const res = await fetch('/api/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          auditId: needsManualInput?.auditId,
          manualHtml: manualHtml || undefined,
          manualScreenshotDesktop: manualDesktopFile || undefined,
          manualScreenshotMobile: manualMobileFile || undefined
        })
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Audit failed.')
      } else if (data.status === 'needs_manual_input') {
        // Auto-capture couldn't get everything it needed — surface exactly
        // which piece(s) failed and why, instead of an all-or-nothing manual mode
        setNeedsManualInput({
          auditId: data.auditId,
          needsManualHtml: data.needsManualHtml,
          needsManualDesktop: data.needsManualDesktop,
          needsManualMobile: data.needsManualMobile,
          reasons: data.reasons
        })
      } else {
        setResult(data.result)
        setCompletedAuditId(data.auditId)
        setScrapeSucceeded(data.scrapeSucceeded)
        setCaptureMode(data.captureMode)
        setNeedsManualInput(null)
      }
    } catch (err) {
      setError('Network error running audit. Please try again.')
    } finally {
      setRunning(false)
    }
  }

  async function promoteToBacklog() {
    if (!completedAuditId) return
    // NOTE: clientId lookup/creation is intentionally left for the Lovable
    // frontend to wire up properly against the clients table/UI — this
    // fallback page just demonstrates the endpoint contract.
    alert('Promote-to-backlog needs a real clientId — wire this up once client records exist. Endpoint: POST /api/backlog/from-audit')
  }

  return (
    <div style={{ minHeight: '100vh', background: '#080E1A', padding: '40px', color: '#fff' }}>
      <div style={{ display: 'flex', gap: '32px', maxWidth: '1400px', margin: '0 auto' }}>
        {/* LEFT — Form */}
        <div style={{ width: '420px', flexShrink: 0 }}>
          <h1 style={{ fontSize: '22px', marginBottom: '24px' }}>♟ Run Fischer Audit</h1>
          <form onSubmit={runAudit}>
            <div style={CARD_STYLE}>
              <div style={{ marginBottom: '16px' }}>
                <label style={LABEL_STYLE}>CLIENT NAME</label>
                <input style={INPUT_STYLE} value={form.clientName} onChange={e => updateForm('clientName', e.target.value)} required />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={LABEL_STYLE}>PAGE URL</label>
                <input style={INPUT_STYLE} value={form.pageUrl} onChange={e => updateForm('pageUrl', e.target.value)} placeholder="https://example.com/page" required />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={LABEL_STYLE}>MONTHLY TRAFFIC</label>
                <input style={INPUT_STYLE} value={form.monthlyTraffic} onChange={e => updateForm('monthlyTraffic', e.target.value)} placeholder="e.g. 15000" required />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={LABEL_STYLE}>CONVERSION RATE %</label>
                <input style={INPUT_STYLE} value={form.currentConversionRate} onChange={e => updateForm('currentConversionRate', e.target.value)} placeholder="e.g. 1.8" required />
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label style={LABEL_STYLE}>AVG ORDER / LEAD VALUE (R)</label>
                <input style={INPUT_STYLE} value={form.avgOrderValue} onChange={e => updateForm('avgOrderValue', e.target.value)} placeholder="e.g. 45000" required />
              </div>
              <div>
                <label style={LABEL_STYLE}>ADDITIONAL CONTEXT</label>
                <textarea style={{ ...INPUT_STYLE, height: '80px' }} value={form.additionalContext} onChange={e => updateForm('additionalContext', e.target.value)} />
              </div>
            </div>

            {/* Confidence-gate manual input — only appears when auto-capture actually needs it */}
            {needsManualInput && (
              <div style={{ ...CARD_STYLE, border: '1px solid #FF6B35' }}>
                <div style={{ color: '#FF6B35', fontWeight: 700, fontSize: '13px', marginBottom: '10px' }}>
                  ⚠ Auto-capture couldn't get everything it needs
                </div>

                {needsManualInput.needsManualHtml && (
                  <div style={{ marginBottom: '14px' }}>
                    <div style={{ fontSize: '11px', color: '#FF6B35', marginBottom: '6px' }}>
                      {needsManualInput.reasons.html}
                    </div>
                    <label style={LABEL_STYLE}>PASTED HTML (DevTools → right-click &lt;html&gt; → Copy → Copy outerHTML)</label>
                    <textarea
                      style={{ ...INPUT_STYLE, height: '100px', fontFamily: 'monospace', fontSize: '11px' }}
                      value={manualHtml} onChange={e => setManualHtml(e.target.value)}
                      placeholder="Paste the copied HTML here"
                    />
                  </div>
                )}

                {(needsManualInput.needsManualDesktop || needsManualInput.needsManualMobile) && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                    {needsManualInput.needsManualDesktop && (
                      <div>
                        <div style={{ fontSize: '11px', color: '#FF6B35', marginBottom: '6px' }}>
                          {needsManualInput.reasons.desktop}
                        </div>
                        <label style={LABEL_STYLE}>DESKTOP SCREENSHOT</label>
                        <input type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleFileUpload(e.target.files[0], setManualDesktopFile)} style={{ fontSize: '12px', color: '#B8C8D8' }} />
                        {manualDesktopFile && <div style={{ fontSize: '11px', color: '#00E5A0', marginTop: '4px' }}>✓ Uploaded</div>}
                      </div>
                    )}
                    {needsManualInput.needsManualMobile && (
                      <div>
                        <div style={{ fontSize: '11px', color: '#FF6B35', marginBottom: '6px' }}>
                          {needsManualInput.reasons.mobile}
                        </div>
                        <label style={LABEL_STYLE}>MOBILE SCREENSHOT</label>
                        <input type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleFileUpload(e.target.files[0], setManualMobileFile)} style={{ fontSize: '12px', color: '#B8C8D8' }} />
                        {manualMobileFile && <div style={{ fontSize: '11px', color: '#00E5A0', marginTop: '4px' }}>✓ Uploaded</div>}
                      </div>
                    )}
                  </div>
                )}

                <p style={{ fontSize: '11px', color: '#7A9BBD', marginTop: '12px' }}>
                  Fill in what's requested above, then hit "Run Fischer Audit" again to continue this same audit.
                </p>
              </div>
            )}

            <button
              type="submit" disabled={running}
              style={{
                width: '100%', padding: '16px',
                background: running ? '#0A3A5A' : 'linear-gradient(135deg, #00C2FF, #0A7FA8)',
                border: 'none', borderRadius: '10px', color: '#080E1A',
                fontSize: '14px', fontWeight: 700, letterSpacing: '1.5px',
                cursor: running ? 'wait' : 'pointer'
              }}
            >
              {running ? 'FISCHER IS ANALYSING...' : needsManualInput ? '♟ CONTINUE AUDIT' : '♟ RUN FISCHER AUDIT'}
            </button>
          </form>
        </div>

        {/* RIGHT — Output */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {error && (
            <div style={{ ...CARD_STYLE, borderColor: '#FF4757', color: '#FF4757' }}>{error}</div>
          )}

          {!result && !running && !error && !needsManualInput && (
            <div style={{
              background: '#112240', border: '1px dashed #1E3A5F', borderRadius: '12px',
              padding: '64px 40px', textAlign: 'center', color: '#4A6A8A'
            }}>
              Fill in the form and run an audit — Fischer now fetches the real page content server-side before analysing it.
            </div>
          )}

          {result && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                <div>
                  <span style={{ fontSize: '13px', color: '#00E5A0', fontWeight: 600 }}>
                    Fischer Score: {result.fischerScore}/100
                  </span>
                  {captureMode && (
                    <span style={{ marginLeft: '12px', fontSize: '11px', color: '#7A9BBD', textTransform: 'uppercase', letterSpacing: '1px' }}>
                      Capture: {captureMode}
                    </span>
                  )}
                  {scrapeSucceeded === false && (
                    <span style={{ marginLeft: '12px', fontSize: '12px', color: '#FF6B35' }}>
                      ⚠ Page could not be fetched — this audit is data-only, see confidence note below
                    </span>
                  )}
                </div>
                <button onClick={promoteToBacklog} style={{
                  padding: '8px 16px', background: 'transparent', border: '1px solid #1E3A5F',
                  borderRadius: '6px', color: '#7A9BBD', fontSize: '12px', cursor: 'pointer'
                }}>PROMOTE FRICTION POINTS TO BACKLOG</button>
              </div>

              <div style={{ ...CARD_STYLE }}>
                <div style={{ color: '#FFD700', fontWeight: 700, marginBottom: '8px' }}>SUMMARY</div>
                <p style={{ color: '#E8F0F8', fontSize: '14px', lineHeight: 1.6 }}>{result.summary}</p>
                <p style={{ color: '#7A9BBD', fontSize: '12px', marginTop: '12px', fontStyle: 'italic' }}>
                  Confidence note: {result.confidenceNote}
                </p>
              </div>

              <div style={CARD_STYLE}>
                <div style={{ color: '#FF4757', fontWeight: 700, marginBottom: '12px' }}>FRICTION POINTS</div>
                {result.frictionPoints.map((fp, i) => (
                  <div key={i} style={{ marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px solid #1E3A5F' }}>
                    <div style={{ color: SEVERITY_COLOR[fp.severity], fontWeight: 700, fontSize: '14px' }}>
                      {i + 1}. {fp.title} — {fp.severity.toUpperCase()}
                    </div>
                    <div style={{ color: '#B8C8D8', fontSize: '13px', marginTop: '6px' }}><b>Location:</b> {fp.location}</div>
                    <div style={{ color: '#B8C8D8', fontSize: '13px', marginTop: '4px' }}><b>Issue:</b> {fp.issue}</div>
                    <div style={{ color: '#00E5A0', fontSize: '13px', marginTop: '4px' }}><b>Fix:</b> {fp.fix}</div>
                  </div>
                ))}
              </div>

              <div style={CARD_STYLE}>
                <div style={{ color: '#00E5A0', fontWeight: 700, marginBottom: '12px' }}>REVENUE IMPACT</div>
                <p style={{ color: '#E8F0F8', fontSize: '13px' }}>
                  Current: R{result.revenueImpact.currentMonthlyRevenue.toLocaleString()}/mo
                  at {result.revenueImpact.currentConversionRate}% CVR
                </p>
                <p style={{ color: '#B8C8D8', fontSize: '13px', marginTop: '8px' }}>
                  Conservative: +R{result.revenueImpact.conservativeAdditionalRevenue.toLocaleString()}/mo &nbsp;|&nbsp;
                  Realistic: +R{result.revenueImpact.realisticAdditionalRevenue.toLocaleString()}/mo &nbsp;|&nbsp;
                  Aggressive: +R{result.revenueImpact.aggressiveAdditionalRevenue.toLocaleString()}/mo
                </p>
                <p style={{ color: '#FFD700', fontSize: '13px', marginTop: '8px' }}>
                  Highest priority: {result.revenueImpact.highestPriorityFix}
                </p>
              </div>

              <div style={CARD_STYLE}>
                <div style={{ color: '#A78BFA', fontWeight: 700, marginBottom: '12px' }}>A/B TEST HYPOTHESES</div>
                {result.abTestHypotheses.map((t, i) => (
                  <div key={i} style={{ marginBottom: '12px' }}>
                    <div style={{ color: '#A78BFA', fontWeight: 700, fontSize: '13px' }}>TEST {i + 1}: {t.name}</div>
                    <div style={{ color: '#B8C8D8', fontSize: '13px', marginTop: '4px' }}>{t.hypothesis}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
