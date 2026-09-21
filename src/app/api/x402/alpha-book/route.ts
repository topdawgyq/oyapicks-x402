import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import {
  fetchAllMarkets,
  type AlphaNormalizedMarket,
} from "@/lib/markets/alpha-arcade";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// =============================================================================
// alpha-book: the COMPLETE live Alpha Arcade catalog in one call.
//
// Reads Alpha live, NOT from market_snapshots. The snapshot is a top-60
// volume slice with multi-choice markets dropped (32 rows of a 967-market
// book, ~3%), and SnapshotMarket has no outcomes[] / outcomePrices[] /
// isMultiChoice fields. It structurally cannot back this product.
//
// No stale fallback on failure. A thinner payload under the same product name
// is worse than an honest 503, and a 503 costs the buyer nothing:
// @x402-avm/next handleSettlement returns early on status >= 400, before
// processSettlement is ever called. Verified 2026-08-09 in dist/esm/index.js.
// =============================================================================

async function handler(_req: NextRequest): Promise<NextResponse> {
  let all: AlphaNormalizedMarket[];

  try {
    all = await fetchAllMarkets();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[alpha-book] live fetch failed: ${msg}`);
    return NextResponse.json(
      {
        error: `Alpha Arcade is not responding (${msg}). No payment was settled; please retry.`,
      },
      { status: 503 },
    );
  }

  if (!all.length) {
    console.error("[alpha-book] live fetch returned zero markets");
    return NextResponse.json(
      {
        error:
          "Alpha Arcade returned no live markets. No payment was settled; please retry.",
      },
      { status: 503 },
    );
  }

  const markets = all.map((m) => ({
    question: m.question,
    slug: m.slug,
    venue: "alpha_arcade",
    endDate: m.endDate || null,
    volume24hUsd: m.volume24h,
    isMultiChoice: m.isMultiChoice,
    outcomes: m.outcomes,
    // 0-1, index-aligned with outcomes[]
    outcomePrices: m.outcomePrices.map((p) => Number(p.toFixed(6))),
    categories: m.categories,
    marketUrl: m.marketUrl,
    marketAppIds: m.marketAppIds,
  }));

  const multiChoiceCount = markets.filter((m) => m.isMultiChoice).length;

  return NextResponse.json({
    product: "oyapicks-alpha-book",
    venue: "alpha_arcade",
    asOf: new Date().toISOString(),
    count: markets.length,
    binaryCount: markets.length - multiChoiceCount,
    multiChoiceCount,
    markets,
    disclaimer:
      "Informational only. Not financial advice. marketAppIds are per-outcome Algorand application IDs for routing orders on live markets; they are not a resolution reference and may not be readable after a market resolves.",
  });
}

// $0.03 in USDC on Algorand MAINNET, via the GoPlausible facilitator.
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
    extensions: {
      // Discovery is declared OUTPUT-ONLY on purpose. This route takes no
      // parameters, and Algorand routes declaring `required` inputs do not
      // catalog in the GoPlausible Bazaar (see README). Do not add an input
      // block here.
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-alpha-book",
            venue: "alpha_arcade",
            asOf: "2026-01-01T00:00:00.000Z",
            count: 1,
            binaryCount: 1,
            multiChoiceCount: 0,
            markets: [
              {
                question: "Example market question?",
                slug: "example-market-question",
                venue: "alpha_arcade",
                endDate: "2026-12-31T00:00:00.000Z",
                volume24hUsd: 4949,
                isMultiChoice: false,
                outcomes: ["Yes", "No"],
                outcomePrices: [0.42, 0.58],
                categories: ["Crypto"],
                marketUrl:
                  "https://www.alphaarcade.com/market/example-market-question",
                marketAppIds: [123456789, 123456789],
              },
            ],
            disclaimer: "Informational only. Not financial advice.",
          },
        },
      }),
    },
    description:
      "The complete live Alpha Arcade catalog in a single call: every open market with question, end date, 24h USD volume, outcome labels, per-outcome implied probabilities (0-1), categories, market URL, and per-outcome Algorand application IDs. Includes multi-choice markets. Sorted by 24h volume descending.",
    mimeType: "application/json",
  },
  algoServer,
);
