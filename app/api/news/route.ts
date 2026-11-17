import { NextResponse } from "next/server";
import { getNews } from "@/lib/live";

export const dynamic = "force-dynamic";

/** GET /api/news — latest central-bank and macro headlines. 503 when the source is unreachable. */
export async function GET() {
  const data = await getNews();
  return data
    ? NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "source unavailable" }, { status: 503 });
}
