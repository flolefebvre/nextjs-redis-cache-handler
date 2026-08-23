import { cacheLife, cacheTag } from "next/cache";

const WORDS =
  "cache handler redis valkey next tag entry stale expire manifest instance render payload stream revalidate update".split(
    " ",
  );

export interface Post {
  id: number;
  title: string;
  excerpt: string;
  body: string[];
}

export interface Comment {
  id: number;
  author: string;
  text: string;
}

/** The instant a cached scope rendered, which every `data-rendered-at` marker carries. */
export function renderedAt(): string {
  return `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}

/** One deterministic post, so that an Entry's size is stable across builds. */
export function makePost(id: number): Post {
  return {
    id,
    title: `Post ${String(id)}: ${words(5, id)}`,
    excerpt: words(30, id * 7),
    body: Array.from({ length: 6 }, (_, index) => words(90, id * 31 + index)),
  };
}

/** The Entry the prerendered list page writes at build time, and `/ppr` reads at runtime. */
export async function getPosts(): Promise<Post[]> {
  "use cache";
  cacheTag("posts");

  return Array.from({ length: 50 }, (_, index) => makePost(index + 1));
}

export async function getPost(id: number): Promise<Post> {
  "use cache";
  cacheTag("posts", `post:${String(id)}`);

  return makePost(id);
}

export async function getComments(postId: number): Promise<Comment[]> {
  "use cache";
  cacheLife("short");
  cacheTag(`comments:${String(postId)}`);

  return Array.from({ length: 20 }, (_, index) => ({
    id: index + 1,
    author: `user${String((postId * 13 + index) % 97)}`,
    text: words(25, postId * 101 + index),
  }));
}

/** The one scope on the `remote` Handler slot: the same store, a different slot. */
export async function getRemoteNote(postId: number): Promise<string> {
  "use cache: remote";
  cacheTag(`remote:${String(postId)}`);

  return `${renderedAt()} ${words(8, postId * 977)}`;
}

function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

function words(count: number, seed: number): string {
  const random = rng(seed);

  return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
}
