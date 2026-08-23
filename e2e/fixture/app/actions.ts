"use server";

import { updateTag } from "next/cache";

export async function invalidatePosts(): Promise<void> {
  updateTag("posts");
}

export async function invalidateComments(postId: number): Promise<void> {
  updateTag(`comments:${String(postId)}`);
}
