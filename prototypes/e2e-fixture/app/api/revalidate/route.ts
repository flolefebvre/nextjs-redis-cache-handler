import { revalidatePath, revalidateTag } from 'next/cache'
import { NextResponse, type NextRequest } from 'next/server'

// GET /api/revalidate?tag=posts            -> revalidateTag(tag, 'max')
// GET /api/revalidate?tag=posts&expire=0   -> revalidateTag(tag, { expire: 0 })
// GET /api/revalidate?path=/posts/1        -> revalidatePath(path)
// GET /api/revalidate?path=/&type=layout   -> revalidatePath(path, type)
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const tag = q.get('tag')
  const path = q.get('path')
  const type = q.get('type') as 'page' | 'layout' | null
  if (tag) {
    if (q.has('expire')) revalidateTag(tag, { expire: Number(q.get('expire')) })
    else revalidateTag(tag, 'max')
  }
  if (path) {
    if (type) revalidatePath(path, type)
    else revalidatePath(path)
  }
  return NextResponse.json({ ok: true, tag, path, type })
}
