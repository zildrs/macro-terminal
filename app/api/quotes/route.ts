import { NextResponse } from "next/server";
import { getQuotes } from "@/lib/prices";
import type { QuotesPayload } from "@/lib/types";

export const dynamic = "force-dynamic";

/** GET /api/quotes — latest price and previous close per instrument (any that are available). 503 when none are. */
export async function GET() {
  const real = await getQuotes();
  if (!real) return NextResponse.json({ error: "source unavailable" }, { status: 503 });
  const body: QuotesPayload = { source: real.provider, fetchedAt: real.fetchedAt, quotes: real.quotes };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
