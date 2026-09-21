import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { getClosingSoon } from "@/lib/x402/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_req: NextRequest): Promise<NextResponse> {
  const markets = await getClosingSoon({ hours: 48 });
  if (!markets.length) {
    return NextResponse.json(
      { error: "no markets closing in the next 48h" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-closing-soon",
    windowHours: 48,
    count: markets.length,
    markets: markets.map((m) => ({
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

// $0.02 in USDC on Algorand MAINNET, via the GoPlausible facilitator.
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
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-closing-soon",
            windowHours: 48,
            count: 1,
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
    description:
      "Prediction markets resolving within 48 hours: question, venue, implied probability, 24h USD volume, and end date.",
    mimeType: "application/json",
  },
  algoServer,
);
