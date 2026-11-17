import { NextResponse, type NextRequest } from "next/server";
import { getCot } from "@/lib/live";

export const dynamic = "force-dynamic";

/** GET /api/cot?key=ES — weekly CFTC positioning for one contract. 503 when CFTC is unreachable. */
export async function GET(req: NextRequest) {
  const data = await getCot(req.nextUrl.searchParams.get("key") ?? "");
  return data
    ? NextResponse.json(data, { headers: { "Cache-Control": "no-store" } })
    : NextResponse.json({ error: "source unavailable or unknown contract" }, { status: 503 });
}
