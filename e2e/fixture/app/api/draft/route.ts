import { draftMode } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

/** Draft Mode on (`?enable=1`) or off, so a Scenario can drive the force-revalidate path. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const draft = await draftMode();
  const enable = request.nextUrl.searchParams.get("enable") !== "0";

  if (enable) draft.enable();
  else draft.disable();

  return NextResponse.json({ ok: true, enabled: enable });
}
