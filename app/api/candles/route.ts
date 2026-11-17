import { NextResponse, type NextRequest } from "next/server";
import { getInstrument, TIMEFRAMES } from "@/lib/instruments";
import { getCandles, Unsupported } from "@/lib/prices";
import type { CandlesPayload, Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/candles?symbol=SPY&tf=1D — OHLCV history for one instrument.
 * 422 for a combination that can't exist (e.g. hourly bars of a daily series); 503 when the source is down.
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  const tf = (req.nextUrl.searchParams.get("tf") ?? "1D") as Timeframe;
  if (getInstrument(symbol).symbol !== symbol || !TIMEFRAMES.includes(tf)) {
    return NextResponse.json({ error: "unknown symbol or timeframe" }, { status: 400 });
  }
  try {
    const res = await getCandles(symbol, tf);
    if (!res) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
    const body: CandlesPayload = { source: res.source as CandlesPayload["source"], symbol, tf, candles: res.candles };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof Unsupported) return NextResponse.json({ error: err.message, unsupported: true }, { status: 422 });
    throw err;
  }
}
