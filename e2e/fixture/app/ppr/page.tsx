import { Suspense } from "react";
import { connection } from "next/server";

import { getPosts, renderedAt } from "@/lib/data";

export default function PprPage() {
  return (
    <main>
      <h1>Partially prerendered</h1>
      <p data-rendered-at="ppr-shell">shell</p>
      <Suspense fallback={<p>loading hole…</p>}>
        <Hole />
      </Suspense>
    </main>
  );
}

async function Hole() {
  await connection();
  const posts = await getPosts();

  return (
    <section>
      <p data-rendered-at="ppr-hole">{renderedAt()}</p>
      <p data-posts-count>{posts.length}</p>
    </section>
  );
}
