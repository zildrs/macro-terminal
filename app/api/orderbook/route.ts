import { NextResponse } from "next/server";
import { getBook } from "@/lib/live";

export const dynamic = "force-dynamic";

/** GET /api/orderbook — BTC/USD order book and per-minute net taker volume from Kraken. 503 when the source is unreachable. */
export async function GET() {
  const data = await getBook();
  return data
    ? NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "source unavailable" }, { status: 503 });
}
