import { NextResponse } from "next/server";
import { getFredSeries } from "@/lib/fred";
import { getPolicy } from "@/lib/live";
import { payloadFromSeries } from "@/lib/macro";

export const dynamic = "force-dynamic";

/**
 * GET /api/macro — Net Liquidity & Macro Regime payload (spec §5), from FRED plus fed funds
 * futures and core CPI for the regime score. 503 when FRED is unreachable.
 */
export async function GET() {
  const [series, policy] = await Promise.all([getFredSeries(), getPolicy()]);
  if (!series) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  const next = policy?.meetings[0];
  const body = payloadFromSeries(series, Date.now(), policy && next ? { cutProb: next.cutProb, hikeProb: next.hikeProb, coreCpi: policy.fed.coreCpi } : undefined);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
