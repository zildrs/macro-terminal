import { NextResponse } from "next/server";
import { getFlows } from "@/lib/live";

export const dynamic = "force-dynamic";

/** GET /api/flows — cross-asset flow proxy (ETF return z-scores). 503 when the source is unreachable. */
export async function GET() {
  const data = await getFlows();
  return data
    ? NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "source unavailable" }, { status: 503 });
}
