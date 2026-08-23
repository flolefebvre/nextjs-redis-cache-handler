import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";

/**
 * The revalidation APIs, reachable over HTTP so a Scenario can run one on either Instance:
 *
 * - `?tag=posts` → `revalidateTag(tag, 'max')`, the Stale form
 * - `?tag=posts&mode=expire` → `revalidateTag(tag, { expire: 0 })`, the Expired form
 * - `?path=/posts/1` → `revalidatePath(path)`
 * - `?path=/&mode=layout` → `revalidatePath(path, 'layout')`
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const query = request.nextUrl.searchParams;
  const tag = query.get("tag");
  const path = query.get("path");
  const mode = query.get("mode");

  if (tag !== null) {
    if (mode === "expire") revalidateTag(tag, { expire: 0 });
    else revalidateTag(tag, "max");
  }
  if (path !== null) {
    if (mode === "layout" || mode === "page") revalidatePath(path, mode);
    else revalidatePath(path);
  }

  return NextResponse.json({ ok: true, tag, path, mode });
}
