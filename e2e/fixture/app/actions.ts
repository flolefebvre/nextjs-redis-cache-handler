"use server";

import { updateTag } from "next/cache";

/** The mutation a Scenario runs on one Instance: `updateTag`, which expires the tag. */
export async function invalidatePosts(): Promise<void> {
  updateTag("posts");
}
