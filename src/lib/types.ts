export type Venue = "polymarket" | "alpha-arcade" | "kalshi";
export type Market = {
  venue: Venue;
  id: string;
  question: string;
  slug: string;
  endDate: string;
  volume24h: number;
  outcomes: string[];
  outcomePrices: number[];
  isMultiChoice: boolean;
  categories: string[];
  marketUrl: string;
  volume1wk?: number;
  // Event timing. eventStart is a real start
  // time (Alpha's gameStartTimeMs, or a Kalshi ticker's embedded start);
  // settlementDue is Kalshi's occurrence_datetime, when it expects the event to
  // be over. Both null when the venue gives neither.
  eventStart?: string | null;
  settlementDue?: string | null;
  polymarket?: {
    conditionId: string;
    clobTokenIds: string[];
    lastTradePrice: number | null;
    bestBid: number | null;
    bestAsk: number | null;
    enableOrderBook: boolean;
    umaResolutionStatuses: string[];
  };
  alphaArcade?: {
    marketAppIds: (number | null)[];
  };
  kalshi?: {
    tickers: string[];
  };
};
