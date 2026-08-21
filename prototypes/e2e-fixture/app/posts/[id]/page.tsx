import { Suspense } from 'react'
import { getPost, renderedAt } from '@/lib/data'
import { Comments } from './comments'
import { invalidateComments } from '../../actions'

export default function PostPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<p>loading post…</p>}>
      <PostRoute params={params} />
    </Suspense>
  )
}

async function PostRoute({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id)
  return (
    <main>
      <PostBody id={id} />
      <Suspense fallback={<p>loading comments…</p>}>
        <Comments postId={id} />
      </Suspense>
      <form action={invalidateComments.bind(null, id)}>
        <button type="submit">updateTag('comments:{id}')</button>
      </form>
    </main>
  )
}

async function PostBody({ id }: { id: number }) {
  'use cache'
  const post = await getPost(id)
  return (
    <article>
      <h1>{post.title}</h1>
      <p data-rendered-at>{renderedAt()}</p>
      {post.body.map((para, i) => (
        <p key={i}>{para}</p>
      ))}
    </article>
  )
}
