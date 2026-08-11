import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Fischer — CRO Agent | Algorithm Agency',
  description: 'Fischer finds every rand your site is leaving on the table.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />
      </head>
      <body style={{ margin: 0, padding: 0, background: '#080E1A', fontFamily: "'Space Grotesk', sans-serif", color: '#FFFFFF', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  )
}
