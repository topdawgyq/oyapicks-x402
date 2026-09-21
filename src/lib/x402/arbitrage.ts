import { fetchAllMarkets } from "@/lib/markets";
import type { Market } from "@/lib/types";

// Cross-venue arbitrage signal: the SAME tournament outcome priced differently
// on Polymarket (per-team binary "Will <team> win <tournament>?") vs Alpha
// Arcade (one multi-choice "<tournament> Winner" market). We join strictly on
// (tournament, team), so we never pair unrelated markets (e.g. a daily crypto
// market with a 5-minute candle). Public prices only: no methodology, edge, or
// sizing is ever exposed. Kalshi excluded (its data can't be resold).

export type ArbSignal = {
  event: string;
  outcome: string;
  polymarket: { question: string; yesPrice: number };
  alphaArcade: { market: string; price: number };
  gapPct: number; // absolute gap in percentage points
  cheaperOn: "polymarket" | "alpha_arcade";
};

type TournamentConfig = {
  event: string; // human label for the event
  alphaNeedle: string; // lowercase substring identifying Alpha's winner market
  pmRegex: RegExp; // captures the team/outcome from a Polymarket question
};

// Only tournaments whose phrasing we have VERIFIED on BOTH venues live here.
// Adding one is a single config entry once you confirm both sides phrase it.
const TOURNAMENTS: TournamentConfig[] = [
  {
    event: "2026 FIFA World Cup Winner",
    alphaNeedle: "world cup winner",
    pmRegex: /^will (.+?) win the 2026 fifa world cup\?*$/i,
  },
];

// A few hard aliases the word-sort below can't infer on its own.
const TEAM_ALIASES: Record<string, string> = {
  usa: "united states",
  us: "united states",
  uae: "united arab emirates",
};

// Filler words that one venue includes and the other drops.
const DROP_WORDS = new Set(["and", "the", "of"]);

// Normalize a team name so the two venues line up despite word order and
// filler words: "Congo DR" === "DR Congo", "Bosnia and Herzegovina" ===
// "Bosnia-Herzegovina". We lowercase, strip punctuation, apply aliases, drop
// filler words, then sort the remaining words so order no longer matters.
function normName(s: string): string {
  let k = s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  k = TEAM_ALIASES[k] ?? k;
  const words = k.split(" ").filter((w) => w && !DROP_WORDS.has(w));
  words.sort();
  return words.join(" ");
}

// The YES price of a Polymarket binary market, or null if not clean.
function yesPrice(m: Market): number | null {
  const i = m.outcomes.findIndex((o) => o.toLowerCase() === "yes");
  if (i === -1) return null;
  const p = m.outcomePrices[i];
  return typeof p === "number" && p > 0 && p < 1 ? p : null;
}

export async function getArbitrageSignals(opts?: {
  minGap?: number; // ignore gaps under this (0..1). default 0.01 = 1 point
  minPrice?: number; // require BOTH legs priced at least this. default 0.01 = 1%
  limit?: number;
}): Promise<ArbSignal[]> {
  const minGap = opts?.minGap ?? 0.01;
  const minPrice = opts?.minPrice ?? 0.01;
  const limit = opts?.limit ?? 25;

  const { markets } = await fetchAllMarkets({
    polymarket: true,
    alphaArcade: true,
    kalshi: false, // never resold
    polymarketLimit: 150,
    alphaLimit: 40,
  });

  const pm = markets.filter((m) => m.venue === "polymarket");
  const alpha = markets.filter((m) => m.venue === "alpha-arcade");

  const out: ArbSignal[] = [];

  for (const t of TOURNAMENTS) {
    // Alpha: the single multi-choice "<tournament> Winner" market.
    const alphaMkt = alpha.find(
      (m) => m.isMultiChoice && m.question.toLowerCase().includes(t.alphaNeedle),
    );
    if (!alphaMkt) continue;

    // Build Alpha's team -> price map (skip junk prices).
    const alphaPrices = new Map<string, number>();
    alphaMkt.outcomes.forEach((label, i) => {
      const price = alphaMkt.outcomePrices[i];
      if (typeof price === "number" && price > 0 && price < 1) {
        alphaPrices.set(normName(label), price);
      }
    });

    // Polymarket: each per-team binary market for this tournament.
    for (const m of pm) {
      const match = m.question.match(t.pmRegex);
      if (!match) continue;
      const team = normName(match[1]);
      const pmYes = yesPrice(m);
      if (pmYes == null) continue;
      const aPrice = alphaPrices.get(team);
      if (aPrice == null) continue;

      // Need real liquidity on BOTH sides, or the "gap" is just one venue
      // not pricing the outcome (e.g. a longshot sitting at ~0).
      if (pmYes < minPrice || aPrice < minPrice) continue;

      const gap = Math.abs(pmYes - aPrice);
      if (gap < minGap) continue;

      out.push({
        event: t.event,
        outcome: match[1].trim(), // original casing for readability
        polymarket: { question: m.question, yesPrice: pmYes },
        alphaArcade: { market: alphaMkt.question, price: aPrice },
        gapPct: Math.round(gap * 100),
        cheaperOn: pmYes < aPrice ? "polymarket" : "alpha_arcade",
      });
    }
  }

  out.sort((a, b) => Math.abs(b.polymarket.yesPrice - b.alphaArcade.price) -
    Math.abs(a.polymarket.yesPrice - a.alphaArcade.price));
  return out.slice(0, limit);
}
