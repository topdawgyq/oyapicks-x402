import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { getTopMarkets } from "@/lib/x402/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same handler logic as the Base /analyze route - just wrapped for Algorand.
async function handler(_req: NextRequest): Promise<NextResponse> {
  const markets = await getTopMarkets(3);
  if (!markets.length) {
    return NextResponse.json(
      { error: "no market data available yet" },
      { status: 503 },
    );
  }
  const picks = markets.map((m) => {
    const pct = Math.round((m.price ?? 0) * 100);
    return {
      market: m.question,
      venue: m.venue,
      impliedProbability: m.price,
      impliedProbabilityPct: pct,
      volume24hUsd: m.volume24h,
      endDate: m.endDate,
      read: `${m.venue}: "${m.question}" is pricing YES near ${pct}%.`,
    };
  });
  return NextResponse.json({
    product: "oyapicks-top-markets",
    count: picks.length,
    markets: picks,
    disclaimer: "Informational only. Not financial advice.",
  });
}

// $0.25 paid in USDC on Algorand MAINNET, via the GoPlausible facilitator.
// Sources: Polymarket + Alpha Arcade only (Kalshi excluded for resale).
export const GET = withX402(
  handler,
  {
    accepts: {
      scheme: "exact",
      network: ALGORAND_MAINNET_CAIP2,
      payTo: ALGO_PAY_TO,
      price: "$0.25",
      extra: { tag: "x402-global-challenge" },
    },
    description:
      "Top 3 prediction markets by 24h volume across Polymarket and Alpha Arcade: question, venue, implied probability, 24h USD volume, and resolution date.",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-top-markets",
            count: 3,
            markets: [
              {
                market: "Example market question?",
                venue: "polymarket",
                impliedProbability: 0.42,
                impliedProbabilityPct: 42,
                volume24hUsd: 100000,
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
