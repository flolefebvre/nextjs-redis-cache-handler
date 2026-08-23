import { Suspense } from "react";
import { cacheTag } from "next/cache";
import { connection } from "next/server";

import { makePost, renderedAt } from "@/lib/data";

export default function BigPage() {
  return (
    <main>
      <h1>Big table</h1>
      <Suspense fallback={<p>loading table…</p>}>
        <Hole />
      </Suspense>
    </main>
  );
}

/**
 * The dynamic hole the table renders in, which is what puts the Entry below out of
 * `next build`'s reach: a hole is never prerendered, so no Instance ever serves this
 * table from its own ISR copy and every request goes through the Cache Handler. A page
 * cached whole would be prerendered, its Entry written by the build workers, and the
 * `set` a Scenario watches for would never happen at runtime.
 */
async function Hole() {
  await connection();

  return <BigTable />;
}

/** The largest Entry the Fixture writes: ≈500 KB of RSC payload for 500 rich rows. */
async function BigTable() {
  "use cache";
  cacheTag("big");
  const rows = Array.from({ length: 500 }, (_, index) => makePost(index + 1));

  return (
    <>
      <p data-rendered-at="big">{renderedAt()}</p>
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{row.id}</td>
              <td>{row.title}</td>
              <td>{row.excerpt}</td>
              <td>{row.body[0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
