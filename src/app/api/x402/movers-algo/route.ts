import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { getMovers } from "@/lib/x402/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_req: NextRequest): Promise<NextResponse> {
  const movers = await getMovers();
  if (!movers.length) {
    return NextResponse.json(
      { error: "no movement data available yet" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-movers",
    count: movers.length,
    movers: movers.map((m) => ({
      venue: m.venue,
      question: m.question,
      oldPrice: m.oldPrice,
      newPrice: m.newPrice,
      changePct: Math.round((m.newPrice - m.oldPrice) * 100),
    })),
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
      "Prediction markets with the biggest probability swings since the last snapshot: venue, question, previous price, new price, and percentage-point change.",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-movers",
            count: 1,
            movers: [
              {
                venue: "polymarket",
                question: "Example market question?",
                oldPrice: 0.40,
                newPrice: 0.55,
                changePct: 15,
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
