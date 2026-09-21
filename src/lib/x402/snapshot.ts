import { supabaseAdmin } from "@/lib/supabase-admin";

// The snapshot read functions behind 8 of the 11 paid endpoints, copied
// verbatim from production. Only functions a published route calls are
// included, and every one of them filters out Kalshi (its data terms don't
// allow resale).
//
// Each reads the `market_snapshots` table: one row per snapshot, each row a
// JSON array of SnapshotMarket. A private scheduled job writes a new row every
// 6 hours from public Polymarket and Alpha Arcade data. See the README
// section "What's not here, and why".

// Public-safe market shape served to paid endpoints.
// Only these five public fields are ever stored or served.
// Results public, methods internal.
export type SnapshotMarket = {
  venue: string;
  question: string;
  price: number | null; // canonical YES price / implied probability (0..1)
  volume24h: number | null;
  endDate: string | null;
};

// A market whose endDate has already passed has no business being served as
// "current" or "top" — the event is over. Applies wherever a product claims
// to show live/forward-looking data. null endDate passes (some venues don't
// always populate it) — better to show it than wrongly hide a live market.
function isNotExpired(m: SnapshotMarket): boolean {
  if (!m.endDate) return true;
  const end = new Date(m.endDate).getTime();
  if (Number.isNaN(end)) return true;
  return end >= Date.now();
}

// Near-decided markets (implied probability outside 5–95%) aren't a useful
// answer to "what's the top/best market right now" — SCOPED to getTopMarkets
// and getTopMarketFromLatestSnapshot only. Confirmed via real testing that
// movers/closing-soon/volume-spikes/arbitrage need near-decided markets to
// work correctly (a market near 0%/100% the day before it resolves is
// EXPECTED for closing-soon, not junk) — do not apply this elsewhere without
// re-checking against real data first.
const TOP_MARKETS_MIN_PRICE = 0.05;
const TOP_MARKETS_MAX_PRICE = 0.95;
function isTalkableForTopMarkets(m: SnapshotMarket): boolean {
  if (m.price == null) return false;
  return m.price >= TOP_MARKETS_MIN_PRICE && m.price <= TOP_MARKETS_MAX_PRICE;
}

// Top N markets by 24h volume, EXCLUDING Kalshi (its data can't be resold) and
// junk entries (price null/0/1). Public-safe only. Used by the paid endpoint.
export async function getTopMarkets(n: number): Promise<SnapshotMarket[]> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("market_snapshots")
    .select("markets")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.markets) return [];
  const markets = (data.markets as SnapshotMarket[]) ?? [];
  const valid = markets.filter(
    (m) =>
      m.venue !== "kalshi" &&
      m.price != null &&
      m.price > 0 &&
      m.price < 1 &&
      isNotExpired(m) &&
      isTalkableForTopMarkets(m),
  );
  valid.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  return valid.slice(0, n);
}


// Keyword search over the latest snapshot. Returns markets whose question
// contains ALL query terms (case-insensitive), ranked by 24h volume.
// Kalshi excluded (its data can't be resold). Public-safe fields only.
export async function searchMarkets(
  query: string,
  limit = 20,
): Promise<SnapshotMarket[]> {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return [];

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("market_snapshots")
    .select("markets")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.markets) return [];

  const markets = (data.markets as SnapshotMarket[]) ?? [];
  const matched = markets.filter((m) => {
    if (m.venue === "kalshi") return false;
    if (m.price == null || m.price <= 0 || m.price >= 1) return false;
    const q = m.question.toLowerCase();
    return terms.every((t) => q.includes(t));
  });

  matched.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  return matched.slice(0, limit);
}


// ---- Movers: biggest price swings between the two most recent snapshots -----
export type Mover = {
  venue: string;
  question: string;
  oldPrice: number;
  newPrice: number;
  change: number; // signed (newPrice - oldPrice), in probability (0..1)
  changePct: number; // signed, in percentage points
  direction: "up" | "down";
};

export async function getMovers(opts?: {
  minChange?: number;
  limit?: number;
}): Promise<Mover[]> {
  const minChange = opts?.minChange ?? 0.03; // ignore swings under 3 points
  const limit = opts?.limit ?? 20;
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("market_snapshots")
    .select("markets, created_at")
    .order("created_at", { ascending: false })
    .limit(2);
  if (error || !data || data.length < 2) return []; // need two snapshots to compare

  const [newer, older] = data;
  const newMarkets = (newer.markets as SnapshotMarket[]) ?? [];
  const oldMarkets = (older.markets as SnapshotMarket[]) ?? [];

  // Index the older snapshot by venue + exact question.
  const key = (m: SnapshotMarket) => m.venue + "|" + m.question;
  const oldByKey = new Map<string, SnapshotMarket>();
  for (const m of oldMarkets) oldByKey.set(key(m), m);

  const movers: Mover[] = [];
  for (const m of newMarkets) {
    if (m.venue === "kalshi") continue;
    if (m.price == null || m.price <= 0 || m.price >= 1) continue;
    const prev = oldByKey.get(key(m));
    if (!prev || prev.price == null || prev.price <= 0 || prev.price >= 1) continue;
    const change = m.price - prev.price;
    if (Math.abs(change) < minChange) continue;
    movers.push({
      venue: m.venue,
      question: m.question,
      oldPrice: prev.price,
      newPrice: m.price,
      change,
      changePct: Math.round(change * 100),
      direction: change >= 0 ? "up" : "down",
    });
  }

  movers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return movers.slice(0, limit);
}


// ---- Closing soon: markets resolving within the next N hours ----------------
// From the latest snapshot. Kalshi excluded (data can't be resold). Junk
// (price null/0/1) filtered. Sorted soonest-first. Public-safe fields only.
export async function getClosingSoon(opts?: {
  hours?: number;
  limit?: number;
}): Promise<SnapshotMarket[]> {
  const hours = opts?.hours ?? 48;
  const limit = opts?.limit ?? 20;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("market_snapshots")
    .select("markets")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.markets) return [];

  const now = Date.now();
  const cutoff = now + hours * 60 * 60 * 1000;

  const markets = (data.markets as SnapshotMarket[]) ?? [];
  const soon = markets.filter((m) => {
    if (m.venue === "kalshi") return false;
    if (m.price == null || m.price <= 0 || m.price >= 1) return false;
    if (!m.endDate) return false;
    const t = Date.parse(m.endDate);
    if (Number.isNaN(t)) return false;
    return t > now && t <= cutoff;
  });

  soon.sort((a, b) => Date.parse(a.endDate as string) - Date.parse(b.endDate as string));
  return soon.slice(0, limit);
}


// ---- New markets: present in newest snapshot but not the previous one -------
// Freshness signal. Matches by venue + exact question (same key as movers).
// Kalshi excluded; junk (price null/0/1) filtered. Sorted by 24h volume.
// Public-safe fields only.
export async function getNewMarkets(opts?: {
  limit?: number;
}): Promise<SnapshotMarket[]> {
  const limit = opts?.limit ?? 20;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("market_snapshots")
    .select("markets, created_at")
    .order("created_at", { ascending: false })
    .limit(2);
  if (error || !data || data.length < 2) return []; // need two snapshots

  const [newer, older] = data;
  const newMarkets = (newer.markets as SnapshotMarket[]) ?? [];
  const oldMarkets = (older.markets as SnapshotMarket[]) ?? [];

  const key = (m: SnapshotMarket) => m.venue + "|" + m.question;
  const oldKeys = new Set(oldMarkets.map(key));

  const fresh = newMarkets.filter((m) => {
    if (m.venue === "kalshi") return false;
    if (m.price == null || m.price <= 0 || m.price >= 1) return false;
    return !oldKeys.has(key(m));
  });

  fresh.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  return fresh.slice(0, limit);
}


// ---- Volume spikes: biggest 24h-volume jumps between the two most recent snapshots ----
// A "spike" = a market whose trailing-24h volume multiplied vs the previous
// snapshot. Mirrors getMovers, but on volume instead of price. minVolume keeps
// tiny/noisy markets out. Kalshi excluded (data can't be resold). Public-safe.
export type VolumeSpike = {
  venue: string;
  question: string;
  oldVolume24h: number;
  newVolume24h: number;
  multiple: number; // newVolume / oldVolume (e.g. 3.2 = 3.2x)
  changePct: number; // ((new - old) / old) * 100, rounded
};

export async function getVolumeSpikes(opts?: {
  minMultiple?: number; // require at least this jump (default 2 = doubled)
  minVolume?: number; // require newVolume at least this many USD (default 5000)
  limit?: number;
}): Promise<VolumeSpike[]> {
  const minMultiple = opts?.minMultiple ?? 2;
  const minVolume = opts?.minVolume ?? 5000;
  const limit = opts?.limit ?? 20;
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("market_snapshots")
    .select("markets, created_at")
    .order("created_at", { ascending: false })
    .limit(2);
  if (error || !data || data.length < 2) return []; // need two snapshots to compare

  const [newer, older] = data;
  const newMarkets = (newer.markets as SnapshotMarket[]) ?? [];
  const oldMarkets = (older.markets as SnapshotMarket[]) ?? [];

  const key = (m: SnapshotMarket) => m.venue + "|" + m.question;
  const oldByKey = new Map<string, SnapshotMarket>();
  for (const m of oldMarkets) oldByKey.set(key(m), m);

  const spikes: VolumeSpike[] = [];
  for (const m of newMarkets) {
    if (m.venue === "kalshi") continue;
    if (m.price == null || m.price <= 0 || m.price >= 1) continue;
    if (m.volume24h == null || m.volume24h < minVolume) continue;
    const prev = oldByKey.get(key(m));
    if (!prev || prev.volume24h == null || prev.volume24h <= 0) continue;
    const multiple = m.volume24h / prev.volume24h;
    if (multiple < minMultiple) continue;
    spikes.push({
      venue: m.venue,
      question: m.question,
      oldVolume24h: prev.volume24h,
      newVolume24h: m.volume24h,
      multiple: Math.round(multiple * 10) / 10,
      changePct: Math.round(((m.volume24h - prev.volume24h) / prev.volume24h) * 100),
    });
  }

  spikes.sort((a, b) => b.multiple - a.multiple);
  return spikes.slice(0, limit);
}


// ---- Probability history: a market's YES price across stored snapshots -------
// Finds the best market match for the query in the latest snapshot, then walks
// back through recent snapshots collecting that market's price over time.
// Kalshi excluded (data can't be resold). Public-safe fields only. The depth of
// the series grows as more snapshots accumulate over time.
export type PricePoint = { time: string; price: number; pricePct: number };
export type PriceHistory = {
  venue: string;
  question: string;
  points: PricePoint[]; // chronological, oldest first
};

export async function getPriceHistory(
  query: string,
  opts?: { snapshots?: number },
): Promise<PriceHistory | null> {
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (!terms.length) return null;

  const maxSnapshots = opts?.snapshots ?? 200;
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("market_snapshots")
    .select("markets, created_at")
    .order("created_at", { ascending: false })
    .limit(maxSnapshots);
  if (error || !data?.length) return null;

  // 1) Pick the target market from the most recent snapshot: a market whose
  //    question contains ALL query terms, highest 24h volume wins. Kalshi out.
  const latest = (data[0].markets as SnapshotMarket[]) ?? [];
  const candidates = latest.filter((m) => {
    if (m.venue === "kalshi") return false;
    if (m.price == null || m.price <= 0 || m.price >= 1) return false;
    const q = m.question.toLowerCase();
    return terms.every((t) => q.includes(t));
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  const target = candidates[0];
  const key = target.venue + "|" + target.question;

  // 2) Walk every snapshot (newest -> oldest) collecting this market's price.
  const points: PricePoint[] = [];
  for (const row of data) {
    const ms = (row.markets as SnapshotMarket[]) ?? [];
    const hit = ms.find((m) => m.venue + "|" + m.question === key);
    if (!hit || hit.price == null || hit.price <= 0 || hit.price >= 1) continue;
    points.push({
      time: String(row.created_at),
      price: hit.price,
      pricePct: Math.round(hit.price * 100),
    });
  }

  // Chronological (oldest first) for a clean time series.
  points.reverse();

  return { venue: target.venue, question: target.question, points };
}
