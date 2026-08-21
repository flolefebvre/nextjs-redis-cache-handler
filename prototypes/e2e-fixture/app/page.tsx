import Link from 'next/link'
import { cacheTag } from 'next/cache'
import { getPosts, renderedAt } from '@/lib/data'
import { invalidatePosts } from './actions'

export default async function ListPage() {
  'use cache'
  cacheTag('list-page')
  const posts = await getPosts()
  return (
    <main>
      <h1>Posts</h1>
      <p data-rendered-at>{renderedAt()}</p>
      <form action={invalidatePosts}>
        <button type="submit">updateTag('posts')</button>
      </form>
      <ul>
        {posts.map((p) => (
          <li key={p.id}>
            <Link href={`/posts/${p.id}`}>{p.title}</Link>
            <p>{p.excerpt}</p>
          </li>
        ))}
      </ul>
    </main>
  )
}
