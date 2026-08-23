import { getRemoteNote } from "@/lib/data";

export async function RemoteNote({ postId }: { postId: number }) {
  const note = await getRemoteNote(postId);

  return <p data-rendered-at="remote-note">{note}</p>;
}
