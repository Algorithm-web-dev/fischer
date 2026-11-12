/** Change-type tags for A/B tests. Dependency-free so client components can import it. */
export const TEST_TAGS: { tag: string; label: string; re: RegExp }[] = [
  { tag: 'cta', label: 'Call to action', re: /\b(cta|button|call to action|book now|get a quote|sign ?up|add to cart)\b/i },
  { tag: 'form', label: 'Form', re: /\b(form|field|fields|step form|multi-?step|input)\b/i },
  { tag: 'headline', label: 'Headline / value proposition', re: /\b(headline|h1|hero|value prop|tagline|heading)\b/i },
  { tag: 'trust', label: 'Trust / social proof', re: /\b(review|testimonial|trust|badge|guarantee|rating|social proof|logo|accredit)/i },
  { tag: 'pricing', label: 'Pricing / offer', re: /\b(price|pricing|discount|offer|free shipping|delivery|finance|from r\d|cost)/i },
  { tag: 'mobile', label: 'Mobile layout', re: /\b(mobile|sticky|tap|thumb)\b/i },
  { tag: 'checkout', label: 'Checkout', re: /\b(checkout|cart|basket|guest|payment)\b/i },
  { tag: 'navigation', label: 'Navigation', re: /\b(nav|navigation|menu|header|breadcrumb)\b/i },
  { tag: 'media', label: 'Images / video', re: /\b(image|photo|video|gallery|visual)\b/i },
  { tag: 'contact', label: 'Contact options', re: /\b(whatsapp|phone|call us|click.to.call|chat)\b/i }
]

export function tagTest(text: string): string[] {
  const tags = TEST_TAGS.filter(t => t.re.test(text)).map(t => t.tag)
  return tags.length ? tags : ['other']
}

