import { NextResponse } from "next/server";
import { getFredRisk, getFredSeries } from "@/lib/fred";
import { computeRisk } from "@/lib/risk";
import { withLivePrices } from "@/lib/risk-live";

export const dynamic = "force-dynamic";

/**
 * GET /api/risk — risk-on / risk-off score, its indicators and the market regime status. Daily
 * history from FRED; S&P 500, Nasdaq, Bitcoin and the dollar brought up to the minute with
 * Hyperliquid prices when it answers. 503 when FRED is unreachable.
 */
export async function GET() {
  const [macro, inputs] = await Promise.all([getFredSeries(), getFredRisk()]);
  if (!macro || !inputs) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  const live = await withLivePrices(inputs).catch((err: unknown) => {
    console.warn(`[risk:live] ${err instanceof Error ? err.message : err}`);
    return null;
  });
  const snap = computeRisk(live?.inputs ?? inputs, macro, "FRED", inputs.fetchedAt);
  if (live) {
    snap.liveAt = new Date(live.at).toISOString();
    for (const ind of snap.indicators) if (live.liveKeys.includes(ind.key as never)) ind.live = true;
  }
  return NextResponse.json(snap, { headers: { "Cache-Control": "no-store" } });
}
