export function sumBy(items, projector) {
  return items.reduce((total, item) => total + Number(projector(item) || 0), 0);
}

function safeQuestion(item) {
  return String(item?.question || "Unknown market");
}

export function buildAnalyticsSnapshot(markets, trades, recentMinutes = 15) {
  const now = Date.now();
  const hotMarkets = markets.filter((market) => {
    const ts = market?.lastLarge?.timestamp;
    if (!ts) return false;
    const ageMinutes = Math.round((now - new Date(ts).getTime()) / 60000);
    return Number.isFinite(ageMinutes) && ageMinutes <= recentMinutes;
  });

  const totalLiquidity = sumBy(markets, (market) => market?.liquidity);
  const totalVolume24h = sumBy(markets, (market) => market?.volume24hr);
  const totalLargeTradeNotional = sumBy(trades, (trade) => trade?.notional);

  const largestTrade = [...trades].sort((a, b) => Number(b?.notional || 0) - Number(a?.notional || 0))[0] || null;

  const sideBreakdown = trades.reduce(
    (acc, trade) => {
      const side = String(trade?.side || "").toUpperCase();
      const notional = Number(trade?.notional || 0);
      if (side === "BUY") acc.buy += notional;
      if (side === "SELL") acc.sell += notional;
      return acc;
    },
    { buy: 0, sell: 0 }
  );

  const outcomeBreakdown = new Map();
  trades.forEach((trade) => {
    const outcome = String(trade?.outcome || "Unknown");
    outcomeBreakdown.set(outcome, (outcomeBreakdown.get(outcome) || 0) + Number(trade?.notional || 0));
  });

  const tradeLeadersByMarket = new Map();
  trades.forEach((trade) => {
    const key = String(trade?.market_id || safeQuestion(trade));
    const current = tradeLeadersByMarket.get(key) || {
      marketId: key,
      question: safeQuestion(trade),
      tradeCount: 0,
      totalNotional: 0,
      largestNotional: 0,
    };
    const notional = Number(trade?.notional || 0);
    current.tradeCount += 1;
    current.totalNotional += notional;
    current.largestNotional = Math.max(current.largestNotional, notional);
    tradeLeadersByMarket.set(key, current);
  });

  const volumeLeaders = [...markets]
    .map((market) => ({
      marketId: market?._key || market?.id || safeQuestion(market),
      question: safeQuestion(market),
      volume24hr: Number(market?.volume24hr || 0),
      liquidity: Number(market?.liquidity || 0),
      category: market?.category || null,
    }))
    .sort((a, b) => {
      if (b.volume24hr !== a.volume24hr) return b.volume24hr - a.volume24hr;
      return b.liquidity - a.liquidity;
    })
    .slice(0, 5);

  return {
    marketCount: markets.length,
    hotMarketCount: hotMarkets.length,
    totalLiquidity,
    totalVolume24h,
    totalLargeTradeNotional,
    largestTrade,
    sideBreakdown,
    outcomeLeaders: [...outcomeBreakdown.entries()]
      .map(([outcome, notional]) => ({ outcome, notional }))
      .sort((a, b) => b.notional - a.notional)
      .slice(0, 4),
    tradeLeaders: [...tradeLeadersByMarket.values()]
      .sort((a, b) => {
        if (b.totalNotional !== a.totalNotional) return b.totalNotional - a.totalNotional;
        return b.tradeCount - a.tradeCount;
      })
      .slice(0, 5),
    volumeLeaders,
  };
}
