import { edgeRenderedAt, getEdgeNote } from "@/lib/edge-note";

export const config = { runtime: "experimental-edge" };

export async function getServerSideProps() {
  return { props: { at: edgeRenderedAt(), note: await getEdgeNote() } };
}

export default function EdgePage({ at, note }: { at: string; note: string }) {
  return (
    <main>
      <h1>Edge</h1>
      <p data-rendered-at="edge">{at}</p>
      <p data-edge-note>{note}</p>
    </main>
  );
}
