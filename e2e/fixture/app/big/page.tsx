import { cacheTag } from "next/cache";

import { makePost, renderedAt } from "@/lib/data";

export default async function BigPage() {
  "use cache";
  cacheTag("big");
  const rows = Array.from({ length: 500 }, (_, index) => makePost(index + 1));

  return (
    <main>
      <h1>Big table</h1>
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
    </main>
  );
}
