import { NextResponse } from "next/server";
import { getFredRisk, getFredSeries } from "@/lib/fred";
import { computeRisk } from "@/lib/risk";

export const dynamic = "force-dynamic";

/** GET /api/risk — risk-on / risk-off score, its indicators and the market regime status. 503 when unreachable. */
export async function GET() {
  const [macro, inputs] = await Promise.all([getFredSeries(), getFredRisk()]);
  if (!macro || !inputs) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  return NextResponse.json(computeRisk(inputs, macro, "FRED", inputs.fetchedAt), { headers: { "Cache-Control": "no-store" } });
}
