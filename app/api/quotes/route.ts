import { NextResponse } from "next/server";
import type { QuotesPayload } from "@/lib/types";
import { getQuotes } from "@/lib/yahoo";

export const dynamic = "force-dynamic";

/** GET /api/quotes — latest (delayed) price and previous close per instrument. 503 when unreachable. */
export async function GET() {
  const real = await getQuotes();
  if (!real) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  const body: QuotesPayload = { source: "YAHOO", fetchedAt: real.fetchedAt, quotes: real.quotes };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
