import { NextResponse } from "next/server";
import { getFredSeries } from "@/lib/fred";

export const dynamic = "force-dynamic";

/** GET /api/macro/series — FRED history for the liquidity and yield-curve panes. 503 when unreachable. */
export async function GET() {
  const series = await getFredSeries();
  return series ? NextResponse.json(series, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "source unavailable" }, { status: 503 });
}
