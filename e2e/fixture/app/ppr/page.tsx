import { Suspense } from "react";
import { cacheTag } from "next/cache";
import { connection } from "next/server";

import { getPosts, renderedAt } from "@/lib/data";

export default function PprPage() {
  return (
    <main>
      <h1>Partially prerendered</h1>
      <ShellNote />
      <Suspense fallback={<p>loading hole…</p>}>
        <Hole />
      </Suspense>
    </main>
  );
}

/**
 * A cached scope of the static shell, tagged like the rest: an expired tag it carries is
 * what makes the shell's staleness on another Instance an observation rather than a
 * constant — an untagged shell staying old would prove nothing.
 */
async function ShellNote() {
  "use cache";
  cacheTag("posts");

  return <p data-rendered-at="ppr-shell">{renderedAt()}</p>;
}

async function Hole() {
  await connection();
  const posts = await getPosts();

  return (
    <section>
      <p data-rendered-at="ppr-request">{renderedAt()}</p>
      <HoleNote />
      <p data-posts-count>{posts.length}</p>
    </section>
  );
}

/**
 * A cached scope only the dynamic hole ever renders, which is the point: `next build`
 * prerenders no hole, so this Entry is absent on the first request, and no re-render of
 * `/` refills it. `getPosts()` cannot stand in for it — the Server Action that expires
 * `posts` re-renders `/` on its own Instance and writes that Entry back before another
 * Instance reads it, which turns the hole's read into a hit.
 */
async function HoleNote() {
  "use cache";
  cacheTag("posts");

  return <p data-rendered-at="ppr-hole">{renderedAt()}</p>;
}
