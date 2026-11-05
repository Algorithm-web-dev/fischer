/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      '@anthropic-ai/sdk',
      '@sparticuz/chromium',
      'puppeteer-core',
      '@google-analytics/data'
    ]
  }
}
module.exports = nextConfig
