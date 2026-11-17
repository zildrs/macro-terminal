import { NextResponse } from "next/server";
import { getCalendar } from "@/lib/live";

export const dynamic = "force-dynamic";

/** GET /api/calendar — this week's economic releases. 503 when the source is unreachable. */
export async function GET() {
  const data = await getCalendar();
  return data
    ? NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "source unavailable" }, { status: 503 });
}
