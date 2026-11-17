import { NextResponse, type NextRequest } from "next/server";
import { getInstrument, TIMEFRAMES } from "@/lib/instruments";
import type { CandlesPayload, Timeframe } from "@/lib/types";
import { getCandles } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

/**
 * GET /api/candles?symbol=SPX&tf=1D — real OHLCV history for one instrument.
 * 503 when the upstream failed; the chart then shows a retrying notice.
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  const tf = (req.nextUrl.searchParams.get("tf") ?? "1D") as Timeframe;
  if (getInstrument(symbol).symbol !== symbol || !TIMEFRAMES.includes(tf)) {
    return NextResponse.json({ error: "unknown symbol or timeframe" }, { status: 400 });
  }
  const candles = await getCandles(symbol, tf);
  if (!candles) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  const body: CandlesPayload = { source: "YAHOO", symbol, tf, candles };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
