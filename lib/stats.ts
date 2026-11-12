/**
 * Statistics for A/B tests and revenue projections — deterministic code, not
 * model output. The model suggests WHAT to test and a plausible lift range;
 * the arithmetic (sample sizes, significance, Rand values) is done here so it
 * is reproducible and defensible in front of a client.
 */

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |err| < 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** Inverse standard normal CDF (Acklam's algorithm). */
export function normalInv(p: number): number {
  if (p <= 0 || p >= 1) throw new Error('p must be in (0,1)')
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  const q = p - 0.5, r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

export interface TestResultStats {
  controlRate: number          // %
  variantRate: number          // %
  absoluteDiff: number         // percentage points
  relativeLift: number         // %
  zScore: number
  pValue: number               // two-sided
  confidence: number           // % (1 - p)
  ciLow: number                // 95% CI of relative lift, %
  ciHigh: number
  significant: boolean         // p < alpha
  winner: 'variant' | 'control' | 'none'
  sampleSufficient: boolean    // each arm reached the planned sample (if given)
  verdict: string
}

/**
 * Two-proportion z-test (pooled SE for the test, unpooled for the CI).
 * Standard, explainable, and what most testing tools report as "confidence".
 */
export function twoProportionTest(
  control: { visitors: number; conversions: number },
  variant: { visitors: number; conversions: number },
  opts: { alpha?: number; plannedSamplePerArm?: number } = {}
): TestResultStats {
  const alpha = opts.alpha ?? 0.05
  const { visitors: nA, conversions: cA } = control
  const { visitors: nB, conversions: cB } = variant
  if (nA <= 0 || nB <= 0) throw new Error('Both arms need at least one visitor.')
  if (cA > nA || cB > nB || cA < 0 || cB < 0) throw new Error('Conversions must be between 0 and visitors.')

  const pA = cA / nA, pB = cB / nB
  const pooled = (cA + cB) / (nA + nB)
  const sePooled = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB))
  const z = sePooled > 0 ? (pB - pA) / sePooled : 0
  const pValue = 2 * (1 - normalCdf(Math.abs(z)))

  const seDiff = Math.sqrt((pA * (1 - pA)) / nA + (pB * (1 - pB)) / nB)
  const zCrit = normalInv(1 - alpha / 2)
  const diffLow = (pB - pA) - zCrit * seDiff
  const diffHigh = (pB - pA) + zCrit * seDiff

  const significant = pValue < alpha
  const sampleSufficient = opts.plannedSamplePerArm ? nA >= opts.plannedSamplePerArm && nB >= opts.plannedSamplePerArm : true
  const winner: TestResultStats['winner'] = significant ? (pB > pA ? 'variant' : 'control') : 'none'
  const rel = pA > 0 ? ((pB - pA) / pA) * 100 : 0

  let verdict: string
  if (!sampleSufficient) {
    verdict = `Not enough traffic yet — keep the test running until each arm reaches ${opts.plannedSamplePerArm!.toLocaleString()} visitors. Early results are unreliable.`
  } else if (winner === 'variant') {
    verdict = `Variant wins: ${round(rel, 1)}% relative lift at ${round((1 - pValue) * 100, 1)}% confidence. Ship it.`
  } else if (winner === 'control') {
    verdict = `Control wins: the variant performed ${round(Math.abs(rel), 1)}% worse at ${round((1 - pValue) * 100, 1)}% confidence. Keep the original.`
  } else {
    verdict = `No significant difference (${round((1 - pValue) * 100, 1)}% confidence). The change neither helped nor hurt measurably.`
  }

  return {
    controlRate: round(pA * 100, 3),
    variantRate: round(pB * 100, 3),
    absoluteDiff: round((pB - pA) * 100, 3),
    relativeLift: round(rel, 2),
    zScore: round(z, 3),
    pValue: round(pValue, 4),
    confidence: round((1 - pValue) * 100, 1),
    ciLow: pA > 0 ? round((diffLow / pA) * 100, 1) : 0,
    ciHigh: pA > 0 ? round((diffHigh / pA) * 100, 1) : 0,
    significant,
    winner,
    sampleSufficient,
    verdict
  }
}

/**
 * Visitors needed PER ARM to detect a relative lift of `mdeRelativePct` from a
 * baseline conversion rate, two-sided test.
 */
export function sampleSizePerArm(
  baselineRatePct: number,
  mdeRelativePct: number,
  opts: { alpha?: number; power?: number } = {}
): number {
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const p1 = baselineRatePct / 100
  const p2 = p1 * (1 + mdeRelativePct / 100)
  if (p1 <= 0 || p1 >= 1 || p2 <= 0 || p2 >= 1) throw new Error('Rates must be between 0% and 100%.')
  const zA = normalInv(1 - alpha / 2)
  const zB = normalInv(power)
  const pBar = (p1 + p2) / 2
  const num = zA * Math.sqrt(2 * pBar * (1 - pBar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
  return Math.ceil((num * num) / ((p2 - p1) ** 2))
}

export interface TestPlan {
  baselineRatePct: number
  mdeRelativePct: number
  samplePerArm: number
  totalSample: number
  dailyVisitors: number
  estimatedDays: number | null    // null = no traffic data
  feasible: boolean               // can finish within maxDays
  note: string
}

/**
 * Turns a hypothesis's expected lift into a concrete plan using the page's real
 * traffic. Tests are run for at least 14 days (two full weekly cycles) even
 * when traffic is high, to avoid day-of-week bias.
 */
export function planTest(params: {
  baselineRatePct: number
  expectedLiftPct: number
  monthlyPageSessions: number
  arms?: number
  trafficShare?: number           // fraction of page traffic entering the test (default 1)
  maxDays?: number
}): TestPlan {
  const arms = params.arms ?? 2
  const share = params.trafficShare ?? 1
  const maxDays = params.maxDays ?? 56
  // Never plan to detect less than a 5% relative change: smaller effects need
  // traffic few clients have and are usually noise.
  const mde = Math.max(5, Math.abs(params.expectedLiftPct))
  const baseline = Math.min(Math.max(params.baselineRatePct, 0.05), 95)
  const perArm = sampleSizePerArm(baseline, mde)
  const total = perArm * arms
  const daily = (params.monthlyPageSessions / 30) * share
  const rawDays = daily > 0 ? Math.ceil(total / daily) : null
  const days = rawDays == null ? null : Math.max(14, rawDays)
  const feasible = days != null && days <= maxDays

  let note: string
  if (days == null) note = 'No traffic data for this page — connect GA4 to estimate test duration.'
  else if (!feasible) note = `At current traffic this needs ~${days} days. Consider testing a bolder change (bigger expected lift), testing on a higher-traffic page, or shipping it as a monitored change instead of an A/B test.`
  else note = `Run for ~${days} days (${perArm.toLocaleString()} visitors per arm) to reliably detect a ${mde}% lift.`

  return {
    baselineRatePct: round(baseline, 2),
    mdeRelativePct: mde,
    samplePerArm: perArm,
    totalSample: total,
    dailyVisitors: Math.round(daily),
    estimatedDays: days,
    feasible,
    note
  }
}

export interface RevenueImpact {
  basis: 'ga4' | 'manual' | 'none'
  monthlyTraffic: number
  currentConversionRate: number
  currentMonthlyConversions: number
  valuePerConversion: number
  currentMonthlyRevenue: number
  conservativeLiftPct: number
  conservativeAdditionalRevenue: number
  realisticLiftPct: number
  realisticAdditionalRevenue: number
  aggressiveLiftPct: number
  aggressiveAdditionalRevenue: number
  currency: string
}

export function computeRevenueImpact(params: {
  monthlyTraffic: number
  conversionRatePct: number
  valuePerConversion: number
  lifts: { conservative: number; realistic: number; aggressive: number }
  basis: RevenueImpact['basis']
  currency: string
}): RevenueImpact {
  const conversions = params.monthlyTraffic * (params.conversionRatePct / 100)
  const revenue = conversions * params.valuePerConversion
  const extra = (lift: number) => Math.round(revenue * (lift / 100))
  return {
    basis: params.basis,
    monthlyTraffic: Math.round(params.monthlyTraffic),
    currentConversionRate: round(params.conversionRatePct, 2),
    currentMonthlyConversions: Math.round(conversions),
    valuePerConversion: params.valuePerConversion,
    currentMonthlyRevenue: Math.round(revenue),
    conservativeLiftPct: params.lifts.conservative,
    conservativeAdditionalRevenue: extra(params.lifts.conservative),
    realisticLiftPct: params.lifts.realistic,
    realisticAdditionalRevenue: extra(params.lifts.realistic),
    aggressiveLiftPct: params.lifts.aggressive,
    aggressiveAdditionalRevenue: extra(params.lifts.aggressive),
    currency: params.currency
  }
}

/** Percentage change helper used by trends/reports; null when there's no baseline. */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null
  return round(((to - from) / Math.abs(from)) * 100, 1)
}

export function round(x: number, dp: number): number {
  const f = 10 ** dp
  return Math.round(x * f) / f
}
