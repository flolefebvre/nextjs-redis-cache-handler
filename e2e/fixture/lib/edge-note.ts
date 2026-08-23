export function edgeRenderedAt(): string {
  return `${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
}

export async function getEdgeNote(): Promise<string> {
  "use cache";

  return `edge note ${edgeRenderedAt()}`;
}
