import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const POLL_MS = 20000;
const ALERT_RECENT_MIN = 15;
const MARKET_PAGE_SIZE = 25;
const MARKET_HISTORY_PAGE_SIZE = 25;
const STREAM_MAX_EVENTS = 100;
const ALL_CATEGORIES = "__all__";

function fmtNumber(value) {
  if (value === null || value === undefined) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed ? value.toFixed(2) : String(value);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseOutcomePrices(outcomes, outcomePrices) {
  const normOutcomes = normalizeList(outcomes);
  const normPrices = normalizeList(outcomePrices);
  if (!normOutcomes.length || !normPrices.length) {
    return { YES: null, NO: null };
  }
  const map = {};
  normOutcomes.forEach((outcome, idx) => {
    const key = String(outcome).trim().toUpperCase();
    const val = Number(normPrices[idx]);
    if (Number.isFinite(val)) {
      map[key] = val;
    }
  });
  return {
    YES: map.YES ?? null,
    NO: map.NO ?? null,
  };
}

function minutesAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  const now = Date.now();
  return Math.round((now - then) / 60000);
}

function marketKey(market) {
  return String(market.conditionId || market.id || "");
}

function tradeKey(trade) {
  return `${trade.market_id}-${trade.asset_id}-${trade.timestamp}-${trade.side}-${trade.size}`;
}

function normalizeCategory(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function toCategoryKey(value) {
  const text = normalizeCategory(value);
  return text ? text.toLowerCase() : null;
}

function mergeUniqueTrades(first, second) {
  const seen = new Set();
  const merged = [];
  [...first, ...second].forEach((trade) => {
    const key = tradeKey(trade);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(trade);
  });
  return merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function defaultHistoryState() {
  return {
    items: [],
    loading: false,
    error: null,
    hasMore: false,
    offset: 0,
  };
}

export default function App() {
  const [markets, setMarkets] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORIES);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [largeTrades, setLargeTrades] = useState([]);
  const [visibleCount, setVisibleCount] = useState(MARKET_PAGE_SIZE);
  const [selectedMarketId, setSelectedMarketId] = useState(null);
  const [marketHistoryById, setMarketHistoryById] = useState({});
  const lastLargeByMarketRef = useRef({});

  useEffect(() => {
    let isMounted = true;

    async function fetchMarkets() {
      try {
        const res = await fetch(`${API_BASE}/api/markets`);
        const data = await res.json();
        if (!isMounted) return;
        setMarkets(data.markets || []);
        setUpdatedAt(data.updated_at || null);
      } catch {
        if (!isMounted) return;
        setUpdatedAt(null);
      }
    }

    fetchMarkets();
    const id = setInterval(fetchMarkets, POLL_MS);

    return () => {
      isMounted = false;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    setVisibleCount(MARKET_PAGE_SIZE);
  }, [searchQuery, selectedCategory]);

  useEffect(() => {
    if (!selectedMarketId) return;
    const exists = markets.some((m) => marketKey(m) === selectedMarketId);
    if (!exists) {
      setSelectedMarketId(null);
    }
  }, [markets, selectedMarketId]);

  useEffect(() => {
    let ws;
    let stopped = false;

    function connect() {
      setWsStatus("connecting");
      ws = new WebSocket(API_BASE.replace("http", "ws") + "/ws/large-trades");

      ws.onopen = () => {
        setWsStatus("live");
        ws.send("ping");
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          setLargeTrades((prev) => [payload, ...prev].slice(0, STREAM_MAX_EVENTS));
          if (payload.market_id) {
            lastLargeByMarketRef.current[payload.market_id] = payload;
            setMarketHistoryById((prev) => {
              const current = prev[payload.market_id];
              if (!current) return prev;
              const nextItems = mergeUniqueTrades([payload], current.items).slice(0, 250);
              return {
                ...prev,
                [payload.market_id]: {
                  ...current,
                  items: nextItems,
                },
              };
            });
          }
        } catch {
          // ignore
        }
      };

      ws.onclose = () => {
        setWsStatus("reconnecting");
        if (!stopped) {
          setTimeout(connect, 1500);
        }
      };

      ws.onerror = () => {
        setWsStatus("error");
        ws.close();
      };
    }

    connect();

    return () => {
      stopped = true;
      if (ws) ws.close();
    };
  }, []);

  const enrichedMarkets = useMemo(() => {
    return markets.map((m) => {
      const prices = parseOutcomePrices(m.outcomes, m.outcomePrices);
      const id = marketKey(m);
      const lastLarge = lastLargeByMarketRef.current[id];
      const category = normalizeCategory(m.category);
      const categoryKey = toCategoryKey(m.categorySlug || category);
      return {
        ...m,
        _key: id,
        category,
        categoryKey,
        prices,
        lastLarge,
      };
    });
  }, [markets, largeTrades]);

  const categoryOptions = useMemo(() => {
    const counts = new Map();
    enrichedMarkets.forEach((market) => {
      if (!market.category || !market.categoryKey) return;
      const existing = counts.get(market.categoryKey);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(market.categoryKey, { key: market.categoryKey, label: market.category, count: 1 });
      }
    });
    return Array.from(counts.values()).sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.label.localeCompare(b.label);
    });
  }, [enrichedMarkets]);

  const marketsByCategory = useMemo(() => {
    if (selectedCategory === ALL_CATEGORIES) return enrichedMarkets;
    return enrichedMarkets.filter((market) => market.categoryKey === selectedCategory);
  }, [enrichedMarkets, selectedCategory]);

  const filteredMarkets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return marketsByCategory;
    return marketsByCategory.filter((market) =>
      String(market.question || "").toLowerCase().includes(q)
    );
  }, [marketsByCategory, searchQuery]);

  const visibleMarkets = useMemo(() => {
    return filteredMarkets.slice(0, visibleCount);
  }, [filteredMarkets, visibleCount]);

  const selectedMarket = useMemo(() => {
    if (!selectedMarketId) return null;
    return enrichedMarkets.find((m) => m._key === selectedMarketId) || null;
  }, [enrichedMarkets, selectedMarketId]);

  const selectedHistory = selectedMarketId
    ? marketHistoryById[selectedMarketId] || defaultHistoryState()
    : defaultHistoryState();

  const loadMarketHistory = useCallback(async (marketId, append = false) => {
    if (!marketId) return;
    let requestOffset = 0;
    setMarketHistoryById((prev) => {
      const current = prev[marketId] || defaultHistoryState();
      requestOffset = append ? current.offset : 0;
      return {
        ...prev,
        [marketId]: {
          ...current,
          loading: true,
          error: null,
        },
      };
    });

    try {
      const res = await fetch(
        `${API_BASE}/api/markets/${encodeURIComponent(marketId)}/large-trades?limit=${MARKET_HISTORY_PAGE_SIZE}&offset=${requestOffset}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const fetched = Array.isArray(data.trades) ? data.trades : [];
      setMarketHistoryById((prev) => {
        const current = prev[marketId] || defaultHistoryState();
        const baseItems = current.items;
        const nextItems = append
          ? mergeUniqueTrades(baseItems, fetched)
          : mergeUniqueTrades(fetched, baseItems);
        return {
          ...prev,
          [marketId]: {
            ...current,
            loading: false,
            error: null,
            hasMore: Boolean(data.has_more),
            offset: requestOffset + fetched.length,
            items: nextItems,
          },
        };
      });
    } catch (err) {
      setMarketHistoryById((prev) => {
        const current = prev[marketId] || defaultHistoryState();
        return {
          ...prev,
          [marketId]: {
            ...current,
            loading: false,
            error: "Could not load trade history.",
          },
        };
      });
    }
  }, []);

  function handleSelectMarket(market) {
    const id = market._key;
    if (!id) return;
    setSelectedMarketId(id);

    setMarketHistoryById((prev) => {
      if (prev[id]) return prev;
      const seed = largeTrades.filter((t) => t.market_id === id).slice(0, MARKET_HISTORY_PAGE_SIZE);
      return {
        ...prev,
        [id]: {
          ...defaultHistoryState(),
          items: seed,
        },
      };
    });

    const existing = marketHistoryById[id];
    if (!existing || (!existing.loading && existing.items.length < MARKET_HISTORY_PAGE_SIZE)) {
      loadMarketHistory(id, false);
    }
  }

  const canLoadMoreMarkets = visibleMarkets.length < filteredMarkets.length;

  return (
    <div className="app">
      <header className="hero">
        <div>
          <p className="eyebrow">Polymarket Watch</p>
          <h1>Live market monitor for large singular trades.</h1>
          <p className="subhead">
            Real-time alerts for outsized trades, with polling market stats.
          </p>
        </div>
        <div className="status">
          <div>
            <span className={`dot ${wsStatus}`} />
            <span>WebSocket: {wsStatus}</span>
          </div>
          <div>
            <span>Markets: {markets.length}</span>
          </div>
          <div>
            <span>Updated: {updatedAt ? new Date(updatedAt).toLocaleTimeString() : "-"}</span>
          </div>
        </div>
      </header>

      <section className="controls">
        <input
          className="search-input"
          type="search"
          placeholder="Search markets..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <span className="results-count">
          {visibleMarkets.length} of {filteredMarkets.length} shown
        </span>
      </section>
      <section className="category-filters">
        <button
          type="button"
          className={`filter-chip ${selectedCategory === ALL_CATEGORIES ? "active" : ""}`}
          onClick={() => setSelectedCategory(ALL_CATEGORIES)}
        >
          All
        </button>
        {categoryOptions.map((option) => (
          <button
            key={option.key}
            type="button"
            className={`filter-chip ${selectedCategory === option.key ? "active" : ""}`}
            onClick={() => setSelectedCategory(option.key)}
          >
            {option.label}
          </button>
        ))}
      </section>

      {selectedMarket && (
        <section className="market-detail">
          <div className="market-detail-header">
            <div>
              <p className="eyebrow">Market Detail</p>
              <h3>{selectedMarket.question || "Unknown market"}</h3>
            </div>
            <button className="btn" onClick={() => setSelectedMarketId(null)} type="button">
              Close
            </button>
          </div>
          <div className="detail-metrics">
            <div>
              <span className="label">Condition ID</span>
              <span className="value mono">{selectedMarket._key}</span>
            </div>
            <div>
              <span className="label">Volume 24h</span>
              <span className="value">{fmtNumber(selectedMarket.volume24hr)}</span>
            </div>
            <div>
              <span className="label">Liquidity</span>
              <span className="value">{fmtNumber(selectedMarket.liquidity)}</span>
            </div>
            <div>
              <span className="label">YES / NO</span>
              <span className="value">
                {selectedMarket.prices.YES ?? "-"} / {selectedMarket.prices.NO ?? "-"}
              </span>
            </div>
            <div>
              <span className="label">End Date</span>
              <span className="value">
                {selectedMarket.endDate ? new Date(selectedMarket.endDate).toLocaleString() : "No end"}
              </span>
            </div>
            <div>
              <span className="label">Outcomes</span>
              <span className="value">{normalizeList(selectedMarket.outcomes).join(", ") || "-"}</span>
            </div>
            <div>
              <span className="label">Category</span>
              <span className="value">{selectedMarket.category || "-"}</span>
            </div>
          </div>

          <div className="market-history">
            <div className="stream-header">
              <h3>Large Trade History</h3>
              <span>{selectedHistory.items.length} loaded</span>
            </div>
            <div className="stream-list">
              {selectedHistory.items.length === 0 && !selectedHistory.loading && (
                <div className="stream-empty">No large trades stored for this market yet.</div>
              )}
              {selectedHistory.items.map((trade, idx) => (
                <div className="stream-row" key={`${tradeKey(trade)}-${idx}`}>
                  <span className="mono">{new Date(trade.timestamp).toLocaleString()}</span>
                  <span className="truncate">{trade.question || selectedMarket.question}</span>
                  <span className="mono">
                    {trade.outcome || "?"} {trade.side || "?"}
                  </span>
                  <span className="mono">
                    {fmtNumber(trade.size)} @ {Number(trade.price || 0).toFixed(3)}
                  </span>
                  <span className="mono">{fmtNumber(trade.notional)} USDC</span>
                </div>
              ))}
            </div>
            {selectedHistory.error && <div className="history-error">{selectedHistory.error}</div>}
            <div className="history-actions">
              <button
                className="btn"
                type="button"
                onClick={() => loadMarketHistory(selectedMarketId, true)}
                disabled={!selectedHistory.hasMore || selectedHistory.loading}
              >
                {selectedHistory.loading ? "Loading..." : selectedHistory.hasMore ? "Load Older Trades" : "No More Trades"}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="grid">
        {visibleMarkets.map((market) => {
          const lastLarge = market.lastLarge;
          const minutes = lastLarge ? minutesAgo(lastLarge.timestamp) : null;
          const isHot = minutes !== null && minutes <= ALERT_RECENT_MIN;
          const isSelected = selectedMarketId && market._key === selectedMarketId;
          return (
            <article
              key={market._key || market.id}
              className={`card ${isHot ? "hot" : ""} ${isSelected ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => handleSelectMarket(market)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleSelectMarket(market);
                }
              }}
            >
              <div className="card-header">
                <h2>{market.question || "Unknown market"}</h2>
                <span className="pill">
                  {market.endDate ? new Date(market.endDate).toLocaleDateString() : "No end"}
                </span>
              </div>
              <div className="metrics">
                <div>
                  <span className="label">Volume 24h</span>
                  <span className="value">{fmtNumber(market.volume24hr)}</span>
                </div>
                <div>
                  <span className="label">Liquidity</span>
                  <span className="value">{fmtNumber(market.liquidity)}</span>
                </div>
                <div>
                  <span className="label">YES</span>
                  <span className="value">{market.prices.YES ?? "-"}</span>
                </div>
                <div>
                  <span className="label">NO</span>
                  <span className="value">{market.prices.NO ?? "-"}</span>
                </div>
              </div>
              <div className="large-trade">
                <span className="label">Last Large Trade</span>
                {lastLarge ? (
                  <div className="trade-detail">
                    <span>
                      {lastLarge.outcome} {lastLarge.side}
                    </span>
                    <span>
                      {fmtNumber(lastLarge.size)} @ {Number(lastLarge.price).toFixed(3)}
                    </span>
                    <span>{fmtNumber(lastLarge.notional)} USDC</span>
                    <span>{minutes} min ago</span>
                  </div>
                ) : (
                  <div className="trade-detail">None yet</div>
                )}
              </div>
            </article>
          );
        })}
      </section>

      {canLoadMoreMarkets && (
        <div className="load-more-wrap">
          <button
            className="btn"
            type="button"
            onClick={() => setVisibleCount((prev) => prev + MARKET_PAGE_SIZE)}
          >
            Show 25 More Markets
          </button>
        </div>
      )}

      <section className="stream">
        <div className="stream-header">
          <h3>Latest Large Trades</h3>
          <span>{largeTrades.length} events</span>
        </div>
        <div className="stream-col-header" aria-hidden="true">
          <span className="mono">Time - execution timestamp</span>
          <span>Market - question traded</span>
          <span className="mono">Side - outcome and direction</span>
          <span className="mono">Size @ Price - contracts at fill price</span>
          <span className="mono">Notional - total USDC value</span>
        </div>
        <div className="stream-list">
          {largeTrades.length === 0 && <div className="stream-empty">Waiting for large trades...</div>}
          {largeTrades.map((trade, idx) => (
            <div className="stream-row" key={`${trade.asset_id}-${trade.timestamp}-${idx}`}>
              <span className="mono">{new Date(trade.timestamp).toLocaleTimeString()}</span>
              <span className="truncate">{trade.question}</span>
              <span className="mono">
                {trade.outcome} {trade.side}
              </span>
              <span className="mono">
                {fmtNumber(trade.size)} @ {Number(trade.price).toFixed(3)}
              </span>
              <span className="mono">{fmtNumber(trade.notional)} USDC</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
