import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { getVolumeSpikes } from "@/lib/x402/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_req: NextRequest): Promise<NextResponse> {
  const spikes = await getVolumeSpikes();
  if (!spikes.length) {
    return NextResponse.json(
      { error: "no volume spike data available yet" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-volume-spikes",
    count: spikes.length,
    spikes: spikes.map((s) => ({
      venue: s.venue,
      question: s.question,
      oldVolume24h: s.oldVolume24h,
      newVolume24h: s.newVolume24h,
      multiple: s.multiple,
      changePct: s.changePct,
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
      "Prediction markets with the largest 24h trading-volume jumps: venue, question, previous and new 24h volume, the multiple, and percent change.",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-volume-spikes",
            count: 1,
            spikes: [
              {
                venue: "polymarket",
                question: "Example market question?",
                oldVolume24h: 12000,
                newVolume24h: 48000,
                multiple: 4,
                changePct: 300,
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
