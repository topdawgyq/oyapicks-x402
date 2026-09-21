import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { getArbitrageSignals } from "@/lib/x402/arbitrage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(_req: NextRequest): Promise<NextResponse> {
  let signals;
  try {
    signals = await getArbitrageSignals({ minGap: 0.01, minPrice: 0.01, limit: 25 });
  } catch {
    return NextResponse.json(
      { error: "venue data unavailable right now, try again shortly" },
      { status: 503 },
    );
  }
  if (!signals.length) {
    return NextResponse.json(
      { error: "no cross-venue arbitrage signals found right now" },
      { status: 503 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-arbitrage",
    count: signals.length,
    signals,
    disclaimer: "Informational only. Not financial advice.",
  });
}

// $0.05 paid in USDC on Algorand MAINNET, via the GoPlausible facilitator.
// Sources: Polymarket + Alpha Arcade only (Kalshi excluded for resale).
export const GET = withX402(
  handler,
  {
    accepts: {
      scheme: "exact",
      network: ALGORAND_MAINNET_CAIP2,
      payTo: ALGO_PAY_TO,
      price: "$0.05",
      extra: { tag: "x402-global-challenge" },
    },
    description:
      "Same outcome priced differently on Polymarket and Alpha Arcade: the event, the outcome, each venue's price, the gap in percentage points, and which venue is cheaper.",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-arbitrage",
            count: 1,
            signals: [
              {
                event: "2026 FIFA World Cup Winner",
                outcome: "Germany",
                polymarket: {
                  question: "Will Germany win the 2026 FIFA World Cup?",
                  yesPrice: 0.0395,
                },
                alphaArcade: {
                  market: "2026 FIFA World Cup Winner",
                  price: 0.024,
                },
                gapPct: 2,
                cheaperOn: "alpha_arcade",
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
