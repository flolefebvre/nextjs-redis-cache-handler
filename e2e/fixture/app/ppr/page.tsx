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

async function HoleNote() {
  "use cache";
  cacheTag("posts");

  return <p data-rendered-at="ppr-hole">{renderedAt()}</p>;
}
