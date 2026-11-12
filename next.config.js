/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      '@anthropic-ai/sdk',
      '@sparticuz/chromium',
      'puppeteer-core',
      '@google-analytics/data'
    ],
    // @sparticuz/chromium loads its browser binary (bin/*.br) from disk at
    // runtime, so Vercel's file tracing doesn't see it and leaves it out of
    // the function bundle ("input directory .../chromium/bin does not exist").
    // Include it explicitly for every API route that may take screenshots.
    outputFileTracingIncludes: {
      '/api/**/*': ['./node_modules/@sparticuz/chromium/bin/**']
    }
  }
}
module.exports = nextConfig
