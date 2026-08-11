/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      '@anthropic-ai/sdk',
      '@sparticuz/chromium',
      'puppeteer-core'
    ]
  }
}
module.exports = nextConfig
