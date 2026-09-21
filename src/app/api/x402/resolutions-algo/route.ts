import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { fetchRecentlyResolvedMarkets } from "@/lib/markets/polymarket";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_req: NextRequest): Promise<NextResponse> {
  let resolutions;
  try {
    resolutions = await fetchRecentlyResolvedMarkets({ limit: 20 });
  } catch {
    return NextResponse.json(
      { error: "resolution source unavailable right now, try again shortly" },
      { status: 503 },
    );
  }
  if (!resolutions.length) {
    return NextResponse.json(
      { error: "no recently resolved markets found" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-resolutions",
    count: resolutions.length,
    resolutions: resolutions.map((r) => ({
      venue: r.venue,
      market: r.question,
      winningOutcome: r.winningOutcome,
      resolvedAt: r.resolvedAt,
      volumeUsd: r.volume,
    })),
    disclaimer: "Informational only. Not financial advice.",
  });
}

// $0.03 paid in USDC on Algorand MAINNET, via the GoPlausible facilitator.
// Source: Polymarket only (Kalshi excluded for resale).
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
      "Recently resolved Polymarket prediction markets: question, winning outcome, resolution timestamp, and USD volume.",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-resolutions",
            count: 1,
            resolutions: [
              {
                venue: "polymarket",
                market: "Example market question?",
                winningOutcome: "No",
                resolvedAt: "2026-06-28T00:00:00Z",
                volumeUsd: 125000,
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
