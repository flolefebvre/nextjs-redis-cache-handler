import type { ReactNode } from 'react'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', margin: 24 }}>
        <nav>
          <a href="/">list</a> · <a href="/posts/1">post 1</a> · <a href="/big">big</a>
        </nav>
        {children}
      </body>
    </html>
  )
}
