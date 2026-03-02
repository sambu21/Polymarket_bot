import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const POLL_MS = 20000;
const ALERT_RECENT_MIN = 15;

function fmtNumber(value) {
  if (value === null || value === undefined) return "-";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed ? value.toFixed(2) : String(value);
}

function parseOutcomePrices(outcomes, outcomePrices) {
  if (!Array.isArray(outcomes) || !Array.isArray(outcomePrices)) {
    return { YES: null, NO: null };
  }
  const map = {};
  outcomes.forEach((outcome, idx) => {
    map[String(outcome).toUpperCase()] = Number(outcomePrices[idx]);
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

export default function App() {
  const [markets, setMarkets] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [largeTrades, setLargeTrades] = useState([]);
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
      } catch (err) {
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
          setLargeTrades((prev) => {
            const next = [payload, ...prev].slice(0, 30);
            return next;
          });
          if (payload.market_id) {
            lastLargeByMarketRef.current[payload.market_id] = payload;
          }
        } catch (err) {
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
      const lastLarge = lastLargeByMarketRef.current[m.conditionId];
      return {
        ...m,
        prices,
        lastLarge,
      };
    });
  }, [markets, largeTrades]);

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

      <section className="grid">
        {enrichedMarkets.map((market) => {
          const lastLarge = market.lastLarge;
          const minutes = lastLarge ? minutesAgo(lastLarge.timestamp) : null;
          const isHot = minutes !== null && minutes <= ALERT_RECENT_MIN;
          return (
            <article key={market.id} className={`card ${isHot ? "hot" : ""}`}>
              <div className="card-header">
                <h2>{market.question || "Unknown market"}</h2>
                <span className="pill">{market.endDate ? new Date(market.endDate).toLocaleDateString() : "No end"}</span>
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
                    <span>{lastLarge.outcome} {lastLarge.side}</span>
                    <span>{fmtNumber(lastLarge.size)} @ {Number(lastLarge.price).toFixed(3)}</span>
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

      <section className="stream">
        <div className="stream-header">
          <h3>Latest Large Trades</h3>
          <span>{largeTrades.length} events</span>
        </div>
        <div className="stream-list">
          {largeTrades.length === 0 && <div className="stream-empty">Waiting for large trades...</div>}
          {largeTrades.map((trade, idx) => (
            <div className="stream-row" key={`${trade.asset_id}-${trade.timestamp}-${idx}`}>
              <span className="mono">{new Date(trade.timestamp).toLocaleTimeString()}</span>
              <span className="truncate">{trade.question}</span>
              <span className="mono">{trade.outcome} {trade.side}</span>
              <span className="mono">{fmtNumber(trade.size)} @ {Number(trade.price).toFixed(3)}</span>
              <span className="mono">{fmtNumber(trade.notional)} USDC</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
