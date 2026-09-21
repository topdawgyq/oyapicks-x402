import { NextRequest, NextResponse } from "next/server";
import { withX402 } from "@x402-avm/next";
import { declareDiscoveryExtension } from "@x402-avm/extensions/bazaar";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";
import { algoServer, ALGO_PAY_TO } from "@/lib/x402/algo-server";
import { searchMarkets } from "@/lib/x402/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The cheap, loopable primitive: one keyword -> the single best-matching live
// market. searchMarkets already sorts by 24h volume desc, so [0] is the top hit.
async function handler(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return NextResponse.json(
      { error: "pass ?q=<keyword> to identify a market" },
      { status: 400 },
    );
  }
  const matches = await searchMarkets(q, 1);
  const m = matches[0];
  if (!m) {
    return NextResponse.json(
      { product: "oyapicks-single-market", query: q, found: false, market: null },
      { status: 200 },
    );
  }
  return NextResponse.json({
    product: "oyapicks-single-market",
    query: q,
    found: true,
    market: {
      question: m.question,
      venue: m.venue,
      impliedProbability: m.price,
      impliedProbabilityPct: Math.round((m.price ?? 0) * 100),
      volume24hUsd: m.volume24h,
      endDate: m.endDate,
    },
    disclaimer: "Informational only. Not financial advice.",
  });
}

// $0.01 paid in USDC on Algorand MAINNET, via the GoPlausible facilitator.
// Sources: Polymarket + Alpha Arcade only (Kalshi excluded for resale).
// Discovery is declared OUTPUT-ONLY (no required inputSchema) on purpose.
// Algorand routes that declare required inputs did not catalog in the
// GoPlausible Bazaar. See README, "Lessons from shipping on MainNet".
export const GET = withX402(
  handler,
  {
    accepts: {
      scheme: "exact",
      network: ALGORAND_MAINNET_CAIP2,
      payTo: ALGO_PAY_TO,
      price: "$0.01",
      extra: { tag: "x402-global-challenge" },
    },
    description:
      "One prediction market by keyword: the single highest-volume live match, with venue, implied probability, 24h USD volume, and end date. Pass ?q=.",
    extensions: {
      ...declareDiscoveryExtension({
        output: {
          example: {
            product: "oyapicks-single-market",
            query: "world cup",
            found: true,
            market: {
              question: "Example market question?",
              venue: "alpha_arcade",
              impliedProbability: 0.62,
              impliedProbabilityPct: 62,
              volume24hUsd: 50000,
              endDate: "2026-12-31T00:00:00Z",
            },
          },
        },
      }),
    },
    mimeType: "application/json",
  },
  algoServer,
);
