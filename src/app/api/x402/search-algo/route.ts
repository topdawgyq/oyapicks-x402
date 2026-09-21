import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { searchMarkets } from "@/lib/x402/snapshot";

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
  const results = await searchMarkets(q);
  return NextResponse.json({
    product: "oyapicks-search",
    query: q,
    count: results.length,
    results: results.map((m) => ({
      market: m.question,
      venue: m.venue,
      impliedProbability: m.price,
      impliedProbabilityPct: Math.round((m.price ?? 0) * 100),
      volume24hUsd: m.volume24h,
      endDate: m.endDate,
    })),
    disclaimer: "Informational only. Not financial advice.",
  });
}

// $0.02 paid in USDC on Algorand MAINNET, via the GoPlausible facilitator.
// Sources: Polymarket + Alpha Arcade only (Kalshi excluded for resale).
export const GET = withX402(
  handler,
  {
    accepts: {
      scheme: "exact",
      network: ALGORAND_MAINNET_CAIP2,
      payTo: ALGO_PAY_TO,
      price: "$0.02",
      extra: { tag: "x402-global-challenge" },
    },
    description:
      "Keyword search of live Polymarket and Alpha Arcade prediction markets. Pass ?q= to get matching questions with venue, implied probability, 24h USD volume, and end date.",
    extensions: {
      ...declareDiscoveryExtension({
        input: { q: "world cup" },
        inputSchema: {
          properties: { q: { type: "string", description: "keyword(s) to search live markets" } },
        },
        output: {
          example: {
            product: "oyapicks-search",
            query: "world cup",
            count: 1,
            results: [
              {
                market: "Example market question?",
                venue: "alpha_arcade",
                impliedProbability: 0.62,
                impliedProbabilityPct: 62,
                volume24hUsd: 50000,
                endDate: "2026-12-31T00:00:00Z",
              },
            ],
          },
        },
      }),
    },
    mimeType: "application/json",
  },
  algoServer,
);
