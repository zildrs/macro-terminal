import { NextResponse } from "next/server";
import { getFredFunding } from "@/lib/fred";

export const dynamic = "force-dynamic";

/** GET /api/funding — TIPS real yields, breakevens, NFCI and money-market spreads. 503 when FRED is unreachable. */
export async function GET() {
  const funding = await getFredFunding();
  if (!funding) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  return NextResponse.json(funding, { headers: { "Cache-Control": "no-store" } });
}
