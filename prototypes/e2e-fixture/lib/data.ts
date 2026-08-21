import { cacheLife, cacheTag } from 'next/cache'

// Deterministic pseudo-random text so sizes are stable across builds.
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}
const WORDS =
  'cache handler redis valkey next tag entry stale expire manifest instance render payload stream revalidate update'.split(
    ' ',
  )
function words(n: number, seed: number) {
  const r = rng(seed)
  return Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ')
}

export type Post = { id: number; title: string; excerpt: string; body: string[] }
export type Comment = { id: number; author: string; text: string }

export function makePost(id: number): Post {
  return {
    id,
    title: `Post ${id}: ${words(5, id)}`,
    excerpt: words(30, id * 7),
    body: Array.from({ length: 6 }, (_, i) => words(90, id * 31 + i)),
  }
}

export async function getPosts(): Promise<Post[]> {
  'use cache'
  cacheTag('posts')
  return Array.from({ length: 50 }, (_, i) => makePost(i + 1))
}

export async function getPost(id: number): Promise<Post> {
  'use cache'
  cacheTag('posts', `post:${id}`)
  return makePost(id)
}

export async function getComments(postId: number): Promise<Comment[]> {
  'use cache'
  cacheLife('short')
  cacheTag(`comments:${postId}`)
  return Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    author: `user${(postId * 13 + i) % 97}`,
    text: words(25, postId * 101 + i),
  }))
}

export function renderedAt() {
  return new Date().toISOString()
}
