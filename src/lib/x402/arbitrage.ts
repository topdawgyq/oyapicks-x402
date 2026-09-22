import { fetchAllMarkets } from "@/lib/markets";

// Cross-venue arbitrage signal: the SAME tournament outcome priced differently
// on Polymarket (per-team binary "Will <team> win <tournament>?") vs Alpha
// Arcade (one multi-choice "<tournament>" market). We join strictly on
// (tournament, team), so we never pair unrelated markets (e.g. a daily crypto
// market with a 5-minute candle). Public prices only: no methodology, edge, or
// sizing is ever exposed. Kalshi excluded (its data can't be resold).
//
// Polymarket side: fetched by EVENT SLUG, not from the top-by-volume list.
// Gamma's /markets returns at most 100 per request, and individual team
// markets ("Will the Yankees win...?") never trade enough to reach that top
// 100. Only a global mega-event (the World Cup) ever did. Asking for the
// tournament's event directly returns every team market in it.

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
  pmEventSlug: string; // Polymarket event holding the per-team markets
  pmRegex: RegExp; // captures the team/outcome from a Polymarket question
};

// Only tournaments whose phrasing we have VERIFIED on BOTH venues live here.
// Adding one is a single config entry once you confirm both sides phrase it.
// World Series verified 2026-09-21: all 10 Alpha options matched a Polymarket
// team market by exact name.
const TOURNAMENTS: TournamentConfig[] = [
  {
    event: "2026 MLB World Series Champion",
    alphaNeedle: "world series champion 2026",
    pmEventSlug: "mlb-world-series-champion-2026",
    pmRegex: /^will (?:the )?(.+?) win the 2026 world series\?*$/i,
  },
];

const GAMMA_BASE = "https://gamma-api.polymarket.com";

type PmTeamMarket = { question: string; yes: number | null };

// Parse a JSON-encoded string array the way Gamma sends outcomes and prices.
function jsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Every OPEN market in one Polymarket event, with its YES price (null if the
// price isn't clean). Closed markets are eliminated teams, already resolved.
async function fetchPolymarketEvent(slug: string): Promise<PmTeamMarket[]> {
  const res = await fetch(`${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Gamma event fetch failed: ${res.status} ${res.statusText}`);
  const data: unknown = await res.json();
  const event = Array.isArray(data) ? (data[0] as { markets?: unknown } | undefined) : undefined;
  const markets = Array.isArray(event?.markets) ? event.markets : [];

  const out: PmTeamMarket[] = [];
  for (const raw of markets) {
    const m = raw as { question?: unknown; outcomes?: unknown; outcomePrices?: unknown; closed?: unknown };
    if (typeof m.question !== "string" || m.closed === true) continue;
    const outcomes = jsonArray(m.outcomes).map((o) => String(o).toLowerCase());
    const prices = jsonArray(m.outcomePrices).map((p) => Number(p));
    const i = outcomes.indexOf("yes");
    const p = i === -1 ? NaN : prices[i];
    out.push({ question: m.question, yes: Number.isFinite(p) && p > 0 && p < 1 ? p : null });
  }
  return out;
}

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

export async function getArbitrageSignals(opts?: {
  minGap?: number; // ignore gaps under this (0..1). default 0.01 = 1 point
  minPrice?: number; // require BOTH legs priced at least this. default 0.01 = 1%
  limit?: number;
}): Promise<ArbSignal[]> {
  const minGap = opts?.minGap ?? 0.01;
  const minPrice = opts?.minPrice ?? 0.01;
  const limit = opts?.limit ?? 25;

  // Alpha: the whole book. Alpha returns its entire catalog in one call and
  // this just skips the top-N slice, so it costs no extra requests, and a
  // tournament market ranked #38 by volume can't fall off the end.
  const { markets } = await fetchAllMarkets({
    polymarket: false, // fetched per tournament by event slug below
    alphaArcade: true,
    kalshi: false, // never resold
    alphaLimit: 5000,
  });

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

    // Polymarket: each per-team binary market in this tournament's event.
    let pm: PmTeamMarket[];
    try {
      pm = await fetchPolymarketEvent(t.pmEventSlug);
    } catch (err) {
      console.error(`[arbitrage] ${t.pmEventSlug}: ${err instanceof Error ? err.message : String(err)}`);
      continue; // one tournament failing never sinks the others
    }

    for (const m of pm) {
      const match = m.question.match(t.pmRegex);
      if (!match) continue;
      const team = normName(match[1]);
      const pmYes = m.yes;
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
