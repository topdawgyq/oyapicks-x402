import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { getPriceHistory } from "@/lib/x402/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json(
      { error: "missing required query param: q" },
      { status: 400 },
    );
  }
  const history = await getPriceHistory(q);
  if (!history || !history.points.length) {
    return NextResponse.json(
      { error: "no matching market with price history yet for that query" },
      { status: 404 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-probability-history",
    query: q,
    market: history.question,
    venue: history.venue,
    count: history.points.length,
    points: history.points,
    disclaimer: "Informational only. Not financial advice.",
  });
}

// $0.03 paid in USDC on Algorand MAINNET, via the GoPlausible facilitator.
// Sources: Polymarket + Alpha Arcade only (Kalshi excluded for resale).
export const GET = withX402(
  handler,
  {
    accepts: {
      scheme: "exact",
      network: ALGORAND_MAINNET_CAIP2,
      payTo: ALGO_PAY_TO,
      price: "$0.03",
      extra: { tag: "x402-global-challenge" },
    },
    description:
      "Probability time series for one prediction market. Pass ?q= to select it; returns the matched market, venue, and dated price points in decimal and percent.",
    extensions: {
      ...declareDiscoveryExtension({
        input: { q: "world cup" },
        inputSchema: {
          properties: {
            q: { type: "string", description: "keyword(s) to pick the market" },
          },
        },
        output: {
          example: {
            product: "oyapicks-probability-history",
            query: "world cup",
            market: "Example market question?",
            venue: "polymarket",
            count: 2,
            points: [
              { time: "2026-06-26T00:00:00Z", price: 0.41, pricePct: 41 },
              { time: "2026-06-27T00:00:00Z", price: 0.47, pricePct: 47 },
            ],
          },
        },
      }),
    },
    mimeType: "application/json",
  },
  algoServer,
);
