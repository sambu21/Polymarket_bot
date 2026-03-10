import { describe, expect, it } from "vitest";
import { buildAnalyticsSnapshot } from "./analytics";

describe("buildAnalyticsSnapshot", () => {
  it("aggregates market and trade analytics", () => {
    const markets = [
      {
        _key: "m1",
        question: "Will BTC close above 100k?",
        volume24hr: 150000,
        liquidity: 80000,
        lastLarge: { timestamp: new Date().toISOString() },
      },
      {
        _key: "m2",
        question: "Will Team A win?",
        volume24hr: 50000,
        liquidity: 30000,
        lastLarge: { timestamp: new Date(Date.now() - 40 * 60 * 1000).toISOString() },
      },
    ];
    const trades = [
      { market_id: "m1", question: "Will BTC close above 100k?", side: "BUY", outcome: "YES", notional: 12000 },
      { market_id: "m1", question: "Will BTC close above 100k?", side: "SELL", outcome: "NO", notional: 8000 },
      { market_id: "m2", question: "Will Team A win?", side: "BUY", outcome: "YES", notional: 6000 },
    ];

    const snapshot = buildAnalyticsSnapshot(markets, trades, 15);

    expect(snapshot.marketCount).toBe(2);
    expect(snapshot.hotMarketCount).toBe(1);
    expect(snapshot.totalLiquidity).toBe(110000);
    expect(snapshot.totalVolume24h).toBe(200000);
    expect(snapshot.totalLargeTradeNotional).toBe(26000);
    expect(snapshot.sideBreakdown.buy).toBe(18000);
    expect(snapshot.sideBreakdown.sell).toBe(8000);
    expect(snapshot.largestTrade?.notional).toBe(12000);
    expect(snapshot.tradeLeaders[0]).toMatchObject({
      marketId: "m1",
      tradeCount: 2,
      totalNotional: 20000,
    });
    expect(snapshot.outcomeLeaders[0]).toMatchObject({
      outcome: "YES",
      notional: 18000,
    });
  });
});
