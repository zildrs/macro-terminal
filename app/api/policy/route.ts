import { NextResponse } from "next/server";
import { getPolicy } from "@/lib/live";

export const dynamic = "force-dynamic";

/** GET /api/policy — policy rates, Fed funds futures path and central bank balance sheets. 503 when the source is unreachable. */
export async function GET() {
  const data = await getPolicy();
  return data
    ? NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "source unavailable" }, { status: 503 });
}
