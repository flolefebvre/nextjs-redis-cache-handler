import Link from "next/link";
import { cacheTag } from "next/cache";

import { getPosts, renderedAt } from "@/lib/data";

export default async function ListPage() {
  "use cache";
  cacheTag("list-page");
  const posts = await getPosts();

  return (
    <main>
      <h1>Posts</h1>
      <p data-rendered-at="list-page">{renderedAt()}</p>
      <ul>
        {posts.map((post) => (
          <li key={post.id}>
            <Link href={`/posts/${String(post.id)}`}>{post.title}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
