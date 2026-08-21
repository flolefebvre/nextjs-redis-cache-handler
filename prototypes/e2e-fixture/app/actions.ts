'use server'
import { updateTag } from 'next/cache'

export async function invalidatePosts() {
  updateTag('posts')
}

export async function invalidateComments(postId: number) {
  updateTag(`comments:${postId}`)
}
