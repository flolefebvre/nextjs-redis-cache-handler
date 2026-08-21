import { cacheTag } from 'next/cache'
import { makePost, renderedAt } from '@/lib/data'

// Deliberately large: 500 rows, to find where a realistic upper bound sits.
export default async function BigPage() {
  'use cache'
  cacheTag('big')
  const rows = Array.from({ length: 500 }, (_, i) => makePost(i + 1))
  return (
    <main>
      <h1>Big table</h1>
      <p data-rendered-at>{renderedAt()}</p>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.title}</td>
              <td>{r.excerpt}</td>
              <td>{r.body[0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
