import { getComments, renderedAt } from '@/lib/data'

export async function Comments({ postId }: { postId: number }) {
  'use cache'
  const comments = await getComments(postId)
  return (
    <section>
      <h2>Comments</h2>
      <p data-rendered-at>{renderedAt()}</p>
      <ul>
        {comments.map((c) => (
          <li key={c.id}>
            <strong>{c.author}</strong>: {c.text}
          </li>
        ))}
      </ul>
    </section>
  )
}
