import { getComments, renderedAt } from "@/lib/data";

export async function Comments({ postId }: { postId: number }) {
  "use cache";
  const comments = await getComments(postId);

  return (
    <section>
      <h2>Comments</h2>
      <p data-rendered-at="comments">{renderedAt()}</p>
      <ul>
        {comments.map((comment) => (
          <li key={comment.id}>
            <strong>{comment.author}</strong>: {comment.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
