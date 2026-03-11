import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearAuthToken, getAuthToken } from "./auth";
import { buildAnalyticsSnapshot } from "./analytics";
import {
  createTradingClient,
  parseMarketTokens,
  TRADING_ASSET_TYPE,
  TRADING_SIDE,
} from "./polymarket";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const POLL_MS = 20000;
const ALERT_RECENT_MIN = 15;
const MARKET_PAGE_SIZE = 25;
const MARKET_HISTORY_PAGE_SIZE = 25;
const STREAM_MAX_EVENTS = 100;
const ALL_CATEGORIES = "__all__";
const DEFAULT_MIN_LARGE_TRADE_USDC = 5000;
const DEFAULT_OUTCOME_MIN = "0.05";
const DEFAULT_OUTCOME_MAX = "0.95";
const DEFAULT_ORDER_SIZE = "10";
const DEFAULT_ORDER_PRICE = "0.50";

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

function tradeNotional(trade) {
  return Number(trade?.notional || 0);
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

function toFloat(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatMaybeNumber(value, digits = 2) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : "-";
}

function withinRange(value, minValue, maxValue) {
  if (value === null || value === undefined) return false;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return false;
  const min = minValue === "" ? null : Number(minValue);
  const max = maxValue === "" ? null : Number(maxValue);
  if (min !== null && Number.isFinite(min) && numeric < min) return false;
  if (max !== null && Number.isFinite(max) && numeric > max) return false;
  return true;
}

function tradeMatchesOutcomePriceFilters(trade, yesMin, yesMax, noMin, noMax) {
  const outcome = String(trade?.outcome || "").trim().toUpperCase();
  if (outcome === "YES") {
    return withinRange(trade?.price, yesMin, yesMax);
  }
  if (outcome === "NO") {
    return withinRange(trade?.price, noMin, noMax);
  }
  return true;
}

export default function App() {
  const navigate = useNavigate();
  const authToken = getAuthToken();
  const [markets, setMarkets] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORIES);
  const [excludedCategoryKeys, setExcludedCategoryKeys] = useState([]);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [largeTrades, setLargeTrades] = useState([]);
  const [minLargeTradeUsdc, setMinLargeTradeUsdc] = useState(DEFAULT_MIN_LARGE_TRADE_USDC);
  const [yesMinFilter, setYesMinFilter] = useState(DEFAULT_OUTCOME_MIN);
  const [yesMaxFilter, setYesMaxFilter] = useState(DEFAULT_OUTCOME_MAX);
  const [noMinFilter, setNoMinFilter] = useState(DEFAULT_OUTCOME_MIN);
  const [noMaxFilter, setNoMaxFilter] = useState(DEFAULT_OUTCOME_MAX);
  const [visibleCount, setVisibleCount] = useState(MARKET_PAGE_SIZE);
  const [selectedMarketId, setSelectedMarketId] = useState(null);
  const [marketHistoryById, setMarketHistoryById] = useState({});
  const [userProfile, setUserProfile] = useState(null);
  const [bookmarksByMarketId, setBookmarksByMarketId] = useState({});
  const [alertsByMarketId, setAlertsByMarketId] = useState({});
  const [linkedWallets, setLinkedWallets] = useState([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [serverAnalytics, setServerAnalytics] = useState(null);
  const [tradingClient, setTradingClient] = useState(null);
  const [tradingWalletAddress, setTradingWalletAddress] = useState("");
  const [tradingStatus, setTradingStatus] = useState("inactive");
  const [tradingNotice, setTradingNotice] = useState("");
  const [tradingError, setTradingError] = useState("");
  const [tradingLoading, setTradingLoading] = useState(false);
  const [approvalLoading, setApprovalLoading] = useState("");
  const [orderSubmitting, setOrderSubmitting] = useState(false);
  const [cancelingOrderId, setCancelingOrderId] = useState("");
  const [marketMeta, setMarketMeta] = useState({ tickSize: "", negRisk: false, lastTradePrice: "" });
  const [balanceState, setBalanceState] = useState({
    collateralBalance: "",
    collateralAllowance: "",
    conditionalBalance: "",
    conditionalAllowance: "",
  });
  const [openOrders, setOpenOrders] = useState([]);
  const [userFills, setUserFills] = useState([]);
  const [orderForm, setOrderForm] = useState({
    side: TRADING_SIDE.BUY,
    outcome: "",
    price: DEFAULT_ORDER_PRICE,
    size: DEFAULT_ORDER_SIZE,
  });

  useEffect(() => {
    let isMounted = true;

    async function fetchMarkets() {
      try {
        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
        const res = await fetch(`${API_BASE}/api/markets`, { headers });
        const data = await res.json();
        if (!isMounted) return;
        setMarkets(data.markets || []);
        setUpdatedAt(data.updated_at || null);
      } catch {
        if (!isMounted) return;
        setUpdatedAt(null);
      }
    }

    async function fetchRecentLargeTrades() {
      try {
        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
        const res = await fetch(`${API_BASE}/api/large-trades?limit=${STREAM_MAX_EVENTS}`, { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (!isMounted) return;
        const fetched = Array.isArray(data.trades) ? data.trades : [];
        setLargeTrades((prev) => mergeUniqueTrades(fetched, prev).slice(0, STREAM_MAX_EVENTS));
      } catch {
        // ignore
      }
    }

    fetchMarkets();
    fetchRecentLargeTrades();
    const id = setInterval(fetchMarkets, POLL_MS);

    return () => {
      isMounted = false;
      clearInterval(id);
    };
  }, [authToken]);

  useEffect(() => {
    setVisibleCount(MARKET_PAGE_SIZE);
  }, [noMaxFilter, noMinFilter, searchQuery, selectedCategory, yesMaxFilter, yesMinFilter]);

  useEffect(() => {
    let cancelled = false;

    async function loadUserState() {
      if (!authToken) {
        setUserProfile(null);
        setBookmarksByMarketId({});
        setAlertsByMarketId({});
        setLinkedWallets([]);
        setPrefsLoaded(false);
        return;
      }

      const headers = { Authorization: `Bearer ${authToken}` };
      try {
        const [meRes, prefsRes, bookmarksRes, alertsRes, walletsRes] = await Promise.all([
          fetch(`${API_BASE}/api/auth/me`, { headers }),
          fetch(`${API_BASE}/api/user/preferences`, { headers }),
          fetch(`${API_BASE}/api/user/bookmarks`, { headers }),
          fetch(`${API_BASE}/api/user/alerts`, { headers }),
          fetch(`${API_BASE}/api/user/wallets`, { headers }),
        ]);
        if (cancelled) return;

        if (meRes.ok) {
          setUserProfile(await meRes.json());
        }
        if (prefsRes.ok) {
          const prefs = await prefsRes.json();
          if (typeof prefs.min_large_trade_usdc === "number") {
            setMinLargeTradeUsdc(Math.max(0, prefs.min_large_trade_usdc));
          }
          if (prefs.default_category_slug) {
            setSelectedCategory(String(prefs.default_category_slug).toLowerCase());
          }
        }
        if (bookmarksRes.ok) {
          const data = await bookmarksRes.json();
          const map = {};
          (data.bookmarks || []).forEach((bookmark) => {
            map[String(bookmark.market_id)] = bookmark;
          });
          setBookmarksByMarketId(map);
        }
        if (alertsRes.ok) {
          const data = await alertsRes.json();
          const map = {};
          (data.alerts || []).forEach((alert) => {
            map[String(alert.market_id)] = alert;
          });
          setAlertsByMarketId(map);
        }
        if (walletsRes.ok) {
          const data = await walletsRes.json();
          setLinkedWallets(Array.isArray(data.wallets) ? data.wallets : []);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setPrefsLoaded(true);
        }
      }
    }

    loadUserState();
    return () => {
      cancelled = true;
    };
  }, [authToken]);

  useEffect(() => {
    if (!selectedMarketId) return;
    const exists = markets.some((m) => marketKey(m) === selectedMarketId);
    if (!exists) {
      setSelectedMarketId(null);
    }
  }, [markets, selectedMarketId]);

  useEffect(() => {
    if (!authToken) {
      setTradingClient(null);
      setTradingWalletAddress("");
      setTradingStatus("inactive");
      setTradingNotice("");
      setTradingError("");
      setOpenOrders([]);
      setUserFills([]);
      setBalanceState({
        collateralBalance: "",
        collateralAllowance: "",
        conditionalBalance: "",
        conditionalAllowance: "",
      });
    }
  }, [authToken]);

  const qualifiedLargeTrades = useMemo(() => {
    return largeTrades.filter((trade) => tradeNotional(trade) >= minLargeTradeUsdc);
  }, [largeTrades, minLargeTradeUsdc]);

  const latestQualifiedTradeByMarket = useMemo(() => {
    const byMarket = new Map();
    qualifiedLargeTrades.forEach((trade) => {
      const id = String(trade.market_id || "");
      if (!id || byMarket.has(id)) return;
      byMarket.set(id, trade);
    });
    return byMarket;
  }, [qualifiedLargeTrades]);

  const enrichedMarkets = useMemo(() => {
    return markets.map((m) => {
      const prices = parseOutcomePrices(m.outcomes, m.outcomePrices);
      const id = marketKey(m);
      const lastLarge = latestQualifiedTradeByMarket.get(id);
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
  }, [markets, latestQualifiedTradeByMarket]);

  const selectedMarket = useMemo(() => {
    if (!selectedMarketId) return null;
    return enrichedMarkets.find((m) => m._key === selectedMarketId) || null;
  }, [enrichedMarkets, selectedMarketId]);
  const primaryWallet = useMemo(() => {
    return linkedWallets.find((wallet) => wallet.is_primary) || linkedWallets[0] || null;
  }, [linkedWallets]);
  const selectedMarketTokens = useMemo(() => {
    return selectedMarket ? parseMarketTokens(selectedMarket) : [];
  }, [selectedMarket]);
  const selectedTradingToken = useMemo(() => {
    if (!selectedMarketTokens.length) return null;
    return (
      selectedMarketTokens.find(
        (token) => token.outcome.toLowerCase() === String(orderForm.outcome || "").toLowerCase()
      ) || selectedMarketTokens[0]
    );
  }, [orderForm.outcome, selectedMarketTokens]);
  const requiredUsdc = useMemo(() => {
    const price = Math.max(0, toFloat(orderForm.price));
    const size = Math.max(0, toFloat(orderForm.size));
    return price * size;
  }, [orderForm.price, orderForm.size]);
  const collateralBalance = toFloat(balanceState.collateralBalance);
  const collateralAllowance = toFloat(balanceState.collateralAllowance);
  const conditionalBalance = toFloat(balanceState.conditionalBalance);
  const conditionalAllowance = toFloat(balanceState.conditionalAllowance);
  const needsCollateralApproval = orderForm.side === TRADING_SIDE.BUY && requiredUsdc > collateralAllowance;
  const needsConditionalApproval = orderForm.side === TRADING_SIDE.SELL && toFloat(orderForm.size) > conditionalAllowance;
  const insufficientCollateral = orderForm.side === TRADING_SIDE.BUY && requiredUsdc > collateralBalance;
  const insufficientShares = orderForm.side === TRADING_SIDE.SELL && toFloat(orderForm.size) > conditionalBalance;
  const canSubmitOrder = Boolean(
    tradingClient &&
      selectedMarket &&
      selectedTradingToken &&
      toFloat(orderForm.price) > 0 &&
      toFloat(orderForm.price) < 1 &&
      toFloat(orderForm.size) > 0 &&
      !needsCollateralApproval &&
      !needsConditionalApproval &&
      !insufficientCollateral &&
      !insufficientShares
  );

  useEffect(() => {
    if (!selectedMarketTokens.length) {
      setOrderForm((prev) => ({
        ...prev,
        outcome: "",
      }));
      return;
    }
    setOrderForm((prev) => {
      const nextOutcome = selectedMarketTokens.some(
        (token) => token.outcome.toLowerCase() === String(prev.outcome || "").toLowerCase()
      )
        ? prev.outcome
        : selectedMarketTokens[0].outcome;
      const activeToken = selectedMarketTokens.find(
        (token) => token.outcome.toLowerCase() === String(nextOutcome || "").toLowerCase()
      );
      const defaultPrice = activeToken?.price ?? 0.5;
      return {
        ...prev,
        outcome: nextOutcome,
        price: prev.outcome === nextOutcome && prev.price ? prev.price : defaultPrice.toFixed(2),
      };
    });
  }, [selectedMarketTokens]);

  useEffect(() => {
    let ws;
    let stopped = false;

    function connect() {
      setWsStatus("connecting");
      const wsBase = API_BASE.replace(/^http/, "ws");
      const suffix = authToken ? `?token=${encodeURIComponent(authToken)}` : "";
      ws = new WebSocket(`${wsBase}/ws/large-trades${suffix}`);

      ws.onopen = () => {
        setWsStatus("live");
        ws.send("ping");
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          setLargeTrades((prev) => [payload, ...prev].slice(0, STREAM_MAX_EVENTS));
          if (payload.market_id) {
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
  }, [authToken]);

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
    return enrichedMarkets.filter((market) => {
      if (selectedCategory !== ALL_CATEGORIES && market.categoryKey !== selectedCategory) {
        return false;
      }
      return true;
    });
  }, [enrichedMarkets, selectedCategory]);

  const activeCategoryLabel = useMemo(() => {
    if (selectedCategory === ALL_CATEGORIES) return "All";
    const selected = categoryOptions.find((option) => option.key === selectedCategory);
    return selected?.label || "Unknown";
  }, [categoryOptions, selectedCategory]);

  const marketCategoryById = useMemo(() => {
    const map = new Map();
    enrichedMarkets.forEach((market) => {
      if (!market._key || !market.categoryKey) return;
      map.set(market._key, market.categoryKey);
    });
    return map;
  }, [enrichedMarkets]);
  const excludedCategoryLabels = useMemo(() => {
    return categoryOptions
      .filter((option) => excludedCategoryKeys.includes(option.key))
      .map((option) => option.label);
  }, [categoryOptions, excludedCategoryKeys]);

  const filteredLargeTrades = useMemo(() => {
    return qualifiedLargeTrades.filter((trade) => {
      const tradeCategory = marketCategoryById.get(String(trade.market_id || ""));
      if (selectedCategory !== ALL_CATEGORIES) {
        if (tradeCategory !== selectedCategory) {
          return false;
        }
      }
      if (tradeCategory && excludedCategoryKeys.includes(tradeCategory)) {
        return false;
      }
      return tradeMatchesOutcomePriceFilters(trade, yesMinFilter, yesMaxFilter, noMinFilter, noMaxFilter);
    });
  }, [excludedCategoryKeys, marketCategoryById, noMaxFilter, noMinFilter, qualifiedLargeTrades, selectedCategory, yesMaxFilter, yesMinFilter]);
  const analytics = useMemo(() => {
    const canUseServerAnalytics = excludedCategoryKeys.length === 0;
    return (canUseServerAnalytics ? serverAnalytics : null) || buildAnalyticsSnapshot(marketsByCategory, filteredLargeTrades, ALERT_RECENT_MIN);
  }, [excludedCategoryKeys.length, filteredLargeTrades, marketsByCategory, serverAnalytics]);

  const alertMatches = useMemo(() => {
    if (!authToken) return [];
    return filteredLargeTrades.filter((trade) => {
      const alert = alertsByMarketId[String(trade.market_id || "")];
      if (!alert || alert.enabled === false) return false;
      return tradeNotional(trade) >= Number(alert.min_notional_usdc || 0);
    });
  }, [alertsByMarketId, authToken, filteredLargeTrades]);

  const filteredMarkets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return marketsByCategory.filter((market) => {
      if (q && !String(market.question || "").toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [marketsByCategory, searchQuery]);

  const visibleMarkets = useMemo(() => {
    return filteredMarkets.slice(0, visibleCount);
  }, [filteredMarkets, visibleCount]);

  const selectedHistory = selectedMarketId
    ? marketHistoryById[selectedMarketId] || defaultHistoryState()
    : defaultHistoryState();
  const selectedHistoryVisibleItems = useMemo(() => {
    return selectedHistory.items.filter((trade) => {
      if (tradeNotional(trade) < minLargeTradeUsdc) {
        return false;
      }
      const tradeCategory = marketCategoryById.get(String(trade.market_id || ""));
      if (tradeCategory && excludedCategoryKeys.includes(tradeCategory)) {
        return false;
      }
      return tradeMatchesOutcomePriceFilters(trade, yesMinFilter, yesMaxFilter, noMinFilter, noMaxFilter);
    });
  }, [excludedCategoryKeys, marketCategoryById, minLargeTradeUsdc, noMaxFilter, noMinFilter, selectedHistory, yesMaxFilter, yesMinFilter]);

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
        `${API_BASE}/api/markets/${encodeURIComponent(marketId)}/large-trades?limit=${MARKET_HISTORY_PAGE_SIZE}&offset=${requestOffset}`,
        {
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        }
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
  }, [authToken]);

  function handleSelectMarket(market) {
    const id = market._key;
    if (!id) return;
    setSelectedMarketId(id);

    setMarketHistoryById((prev) => {
      if (prev[id]) return prev;
      const seed = qualifiedLargeTrades.filter((t) => t.market_id === id).slice(0, MARKET_HISTORY_PAGE_SIZE);
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

  async function toggleBookmark(market) {
    if (!authToken) {
      navigate("/login");
      return;
    }
    const marketId = market._key;
    const exists = Boolean(bookmarksByMarketId[marketId]);
    const headers = {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    };
    if (exists) {
      const res = await fetch(`${API_BASE}/api/user/bookmarks/${encodeURIComponent(marketId)}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) return;
      setBookmarksByMarketId((prev) => {
        const next = { ...prev };
        delete next[marketId];
        return next;
      });
      return;
    }
    const res = await fetch(`${API_BASE}/api/user/bookmarks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        market_id: marketId,
        question: market.question || null,
      }),
    });
    if (!res.ok) return;
    setBookmarksByMarketId((prev) => ({
      ...prev,
      [marketId]: {
        market_id: marketId,
        question: market.question || null,
      },
    }));
  }

  async function upsertAlert(marketId, minNotionalUsdc, enabled = true) {
    if (!authToken) {
      navigate("/login");
      return;
    }
    const headers = {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    };
    const minNotional = Math.max(0, Number(minNotionalUsdc || 0));
    const res = await fetch(`${API_BASE}/api/user/alerts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        market_id: marketId,
        min_notional_usdc: minNotional,
        enabled,
      }),
    });
    if (!res.ok) return;
    setAlertsByMarketId((prev) => ({
      ...prev,
      [marketId]: {
        market_id: marketId,
        min_notional_usdc: minNotional,
        enabled,
      },
    }));
  }

  async function removeAlert(marketId) {
    if (!authToken) {
      navigate("/login");
      return;
    }
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${API_BASE}/api/user/alerts/${encodeURIComponent(marketId)}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) return;
    setAlertsByMarketId((prev) => {
      const next = { ...prev };
      delete next[marketId];
      return next;
    });
  }

  async function connectAndLinkWallet() {
    if (!authToken) {
      navigate("/login");
      return;
    }
    if (!window?.ethereum) {
      setWalletError("No wallet provider found. Install MetaMask.");
      return;
    }
    setWalletError("");
    setWalletLoading(true);
    try {
      const headers = {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      };
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      const walletAddress = String((accounts || [])[0] || "").toLowerCase();
      if (!walletAddress) throw new Error("No wallet account selected");

      const challengeRes = await fetch(`${API_BASE}/api/user/wallets/challenge`, {
        method: "POST",
        headers,
        body: JSON.stringify({ wallet_address: walletAddress }),
      });
      const challenge = await challengeRes.json();
      if (!challengeRes.ok) throw new Error(challenge?.detail || "Could not create challenge");

      const signature = await window.ethereum.request({
        method: "personal_sign",
        params: [challenge.message, walletAddress],
      });

      const verifyRes = await fetch(`${API_BASE}/api/user/wallets/verify`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          wallet_address: walletAddress,
          nonce: challenge.nonce,
          signature,
        }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyRes.ok) throw new Error(verifyData?.detail || "Wallet verification failed");
      setLinkedWallets(Array.isArray(verifyData.wallets) ? verifyData.wallets : []);
    } catch (err) {
      setWalletError(err.message || "Wallet linking failed");
    } finally {
      setWalletLoading(false);
    }
  }

  async function setPrimaryWallet(walletAddress) {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${API_BASE}/api/user/wallets/${encodeURIComponent(walletAddress)}/primary`, {
      method: "PUT",
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setWalletError(data?.detail || "Could not set primary wallet");
      return;
    }
    setWalletError("");
    setLinkedWallets(Array.isArray(data.wallets) ? data.wallets : []);
  }

  async function unlinkWallet(walletAddress) {
    const headers = { Authorization: `Bearer ${authToken}` };
    const res = await fetch(`${API_BASE}/api/user/wallets/${encodeURIComponent(walletAddress)}`, {
      method: "DELETE",
      headers,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setWalletError(data?.detail || "Could not remove wallet");
      return;
    }
    setWalletError("");
    setLinkedWallets(Array.isArray(data.wallets) ? data.wallets : []);
  }

  function toggleExcludedCategory(categoryKey) {
    setExcludedCategoryKeys((prev) => (
      prev.includes(categoryKey)
        ? prev.filter((key) => key !== categoryKey)
        : [...prev, categoryKey]
    ));
  }

  const ensureTradingClient = useCallback(async () => {
    if (!authToken) {
      navigate("/login");
      throw new Error("Login required to trade");
    }
    if (!linkedWallets.length) {
      throw new Error("Link a wallet to your account before trading");
    }
    setTradingError("");
    setTradingNotice("");
    setTradingStatus("connecting");
    const { client, address } = await createTradingClient();
    const linked = linkedWallets.find(
      (wallet) => String(wallet.wallet_address || "").toLowerCase() === address
    );
    if (!linked) {
      throw new Error("Connected wallet is not linked to this account");
    }
    setTradingClient(client);
    setTradingWalletAddress(address);
    setTradingStatus("ready");
    setTradingNotice(`Trading wallet ready: ${address.slice(0, 6)}...${address.slice(-4)}`);
    return { client, address, linkedWallet: linked };
  }, [authToken, linkedWallets, navigate]);

  const loadTradingData = useCallback(async () => {
    if (!tradingClient || !selectedMarket || !selectedTradingToken) return;
    setTradingLoading(true);
    setTradingError("");
    try {
      const [orderBook, collateral, conditional, orders, trades] = await Promise.all([
        tradingClient.getOrderBook(selectedTradingToken.tokenId),
        tradingClient.getBalanceAllowance({ asset_type: TRADING_ASSET_TYPE.COLLATERAL }),
        tradingClient.getBalanceAllowance({
          asset_type: TRADING_ASSET_TYPE.CONDITIONAL,
          token_id: selectedTradingToken.tokenId,
        }),
        tradingClient.getOpenOrders({ market: selectedMarket._key }),
        tradingClient.getTrades({ market: selectedMarket._key }, true),
      ]);
      setMarketMeta({
        tickSize: orderBook?.tick_size || "",
        negRisk: Boolean(orderBook?.neg_risk),
        lastTradePrice: orderBook?.last_trade_price || "",
      });
      setBalanceState({
        collateralBalance: collateral?.balance || "",
        collateralAllowance: collateral?.allowance || "",
        conditionalBalance: conditional?.balance || "",
        conditionalAllowance: conditional?.allowance || "",
      });
      setOpenOrders(Array.isArray(orders) ? orders : []);
      setUserFills(Array.isArray(trades) ? trades.slice(0, 12) : []);
    } catch (err) {
      setTradingError(err.message || "Could not load trading data");
    } finally {
      setTradingLoading(false);
    }
  }, [selectedMarket, selectedTradingToken, tradingClient]);

  async function activateTrading() {
    try {
      await ensureTradingClient();
    } catch (err) {
      setTradingStatus("error");
      setTradingError(err.message || "Could not activate trading");
    }
  }

  async function updateAllowance(assetType) {
    try {
      const session = tradingClient ? { client: tradingClient } : await ensureTradingClient();
      if (!selectedTradingToken) {
        throw new Error("Select an outcome token first");
      }
      setApprovalLoading(assetType);
      setTradingError("");
      setTradingNotice("");
      const params = assetType === TRADING_ASSET_TYPE.CONDITIONAL
        ? { asset_type: assetType, token_id: selectedTradingToken.tokenId }
        : { asset_type: assetType };
      await session.client.updateBalanceAllowance(params);
      setTradingNotice(
        assetType === TRADING_ASSET_TYPE.COLLATERAL
          ? "USDC approval updated"
          : `Approval updated for ${selectedTradingToken.outcome}`
      );
      await loadTradingData();
    } catch (err) {
      setTradingError(err.message || "Could not update allowance");
    } finally {
      setApprovalLoading("");
    }
  }

  async function submitOrder() {
    try {
      const session = tradingClient ? { client: tradingClient } : await ensureTradingClient();
      if (!selectedTradingToken) {
        throw new Error("This market has no tradable token mapping");
      }
      const price = Number(orderForm.price);
      const size = Number(orderForm.size);
      if (!Number.isFinite(price) || price <= 0 || price >= 1) {
        throw new Error("Price must be between 0 and 1");
      }
      if (!Number.isFinite(size) || size <= 0) {
        throw new Error("Size must be greater than 0");
      }
      const tickSize = marketMeta.tickSize || (await session.client.getTickSize(selectedTradingToken.tokenId));
      const negRisk = typeof marketMeta.negRisk === "boolean"
        ? marketMeta.negRisk
        : await session.client.getNegRisk(selectedTradingToken.tokenId);
      setOrderSubmitting(true);
      setTradingError("");
      setTradingNotice("");
      await session.client.createAndPostOrder(
        {
          tokenID: selectedTradingToken.tokenId,
          price,
          size,
          side: orderForm.side,
        },
        {
          tickSize,
          negRisk,
        },
        "GTC"
      );
      setTradingNotice(`Order submitted: ${orderForm.side} ${size} ${selectedTradingToken.outcome} @ ${price}`);
      await loadTradingData();
    } catch (err) {
      setTradingError(err.message || "Order submission failed");
    } finally {
      setOrderSubmitting(false);
    }
  }

  async function cancelOpenOrder(orderId) {
    try {
      const session = tradingClient ? { client: tradingClient } : await ensureTradingClient();
      setCancelingOrderId(orderId);
      setTradingError("");
      setTradingNotice("");
      await session.client.cancelOrder({ orderID: orderId });
      setTradingNotice(`Canceled order ${orderId.slice(0, 10)}...`);
      await loadTradingData();
    } catch (err) {
      setTradingError(err.message || "Could not cancel order");
    } finally {
      setCancelingOrderId("");
    }
  }

  const canLoadMoreMarkets = visibleMarkets.length < filteredMarkets.length;

  useEffect(() => {
    if (!authToken || !prefsLoaded) return;
    const headers = {
      Authorization: `Bearer ${authToken}`,
      "Content-Type": "application/json",
    };
    const body = JSON.stringify({
      default_category_slug: selectedCategory === ALL_CATEGORIES ? null : selectedCategory,
      min_large_trade_usdc: minLargeTradeUsdc,
    });
    const timer = setTimeout(() => {
      fetch(`${API_BASE}/api/user/preferences`, {
        method: "PUT",
        headers,
        body,
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [authToken, minLargeTradeUsdc, prefsLoaded, selectedCategory]);

  useEffect(() => {
    let cancelled = false;

    async function fetchAnalytics() {
      if (excludedCategoryKeys.length > 0) {
        setServerAnalytics(null);
        return;
      }
      try {
        const params = new URLSearchParams({
          category: selectedCategory,
          min_notional: String(minLargeTradeUsdc),
        });
        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
        const res = await fetch(`${API_BASE}/api/analytics/overview?${params.toString()}`, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setServerAnalytics(data.analytics || null);
        }
      } catch {
        if (!cancelled) {
          setServerAnalytics(null);
        }
      }
    }

    fetchAnalytics();
    return () => {
      cancelled = true;
    };
  }, [authToken, excludedCategoryKeys.length, minLargeTradeUsdc, selectedCategory]);

  useEffect(() => {
    if (!tradingClient || !selectedMarket || !selectedTradingToken) return;
    loadTradingData();
  }, [loadTradingData, selectedMarket, selectedTradingToken, tradingClient]);

  useEffect(() => {
    if (!tradingWalletAddress) return;
    const stillLinked = linkedWallets.some(
      (wallet) => String(wallet.wallet_address || "").toLowerCase() === tradingWalletAddress
    );
    if (stillLinked) return;
    setTradingClient(null);
    setTradingWalletAddress("");
    setTradingStatus("inactive");
    setTradingNotice("");
  }, [linkedWallets, tradingWalletAddress]);

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
          <div>
            {authToken ? <span className="auth-user">{userProfile?.email || "Signed in"}</span> : null}
          </div>
          <div>
            {authToken ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  clearAuthToken();
                  window.location.reload();
                }}
              >
                Logout
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => navigate("/login")}
              >
                Login / Register
              </button>
            )}
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
      <details className="advanced-search">
        <summary>Filter Large Trades</summary>
        <div className="advanced-search-note">
          These filters narrow the large-trade feed
        </div>
        <div className="advanced-search-section">
          <span className="label">Exclude market types</span>
          <div className="advanced-search-chips">
            {categoryOptions.map((option) => (
              <button
                key={`exclude-${option.key}`}
                type="button"
                className={`filter-chip ${excludedCategoryKeys.includes(option.key) ? "active" : ""}`}
                onClick={() => toggleExcludedCategory(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div className="advanced-search-grid">
          <label className="min-usdc-control">
            <span>Min large trade (USDC)</span>
            <input
              className="min-usdc-input"
              type="number"
              min="0"
              step="100"
              value={minLargeTradeUsdc}
              onChange={(e) => setMinLargeTradeUsdc(Math.max(0, Number(e.target.value || 0)))}
            />
          </label>
          <label className="price-range-control">
            <span>YES</span>
            <input
              className="price-range-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="min"
              value={yesMinFilter}
              onChange={(e) => setYesMinFilter(e.target.value)}
            />
            <input
              className="price-range-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="max"
              value={yesMaxFilter}
              onChange={(e) => setYesMaxFilter(e.target.value)}
            />
          </label>
          <label className="price-range-control">
            <span>NO</span>
            <input
              className="price-range-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="min"
              value={noMinFilter}
              onChange={(e) => setNoMinFilter(e.target.value)}
            />
            <input
              className="price-range-input"
              type="number"
              min="0"
              max="1"
              step="0.01"
              placeholder="max"
              value={noMaxFilter}
              onChange={(e) => setNoMaxFilter(e.target.value)}
            />
          </label>
        </div>
      </details>
      <details className="analytics-board" open>
        <summary className="collapsible-summary">
          <div>
            <p className="eyebrow">Analytics Dashboard</p>
            <h3>{activeCategoryLabel} Flow Snapshot</h3>
          </div>
          <span className="pill">Last 48h large trades + current market snapshot</span>
        </summary>
        <div className="analytics-grid">
          <article className="analytics-card">
            <span className="label">Filtered Markets</span>
            <span className="value">{analytics.marketCount}</span>
            <span className="label">Hot in last {ALERT_RECENT_MIN}m: {analytics.hotMarketCount}</span>
          </article>
          <article className="analytics-card">
            <span className="label">Liquidity in View</span>
            <span className="value">{fmtNumber(analytics.totalLiquidity)}</span>
            <span className="label">24h volume: {fmtNumber(analytics.totalVolume24h)}</span>
          </article>
          <article className="analytics-card">
            <span className="label">Large Trade Flow</span>
            <span className="value">{fmtNumber(analytics.totalLargeTradeNotional)} USDC</span>
            <span className="label">
              BUY {fmtNumber(analytics.sideBreakdown.buy)} / SELL {fmtNumber(analytics.sideBreakdown.sell)}
            </span>
          </article>
          <article className="analytics-card">
            <span className="label">Largest Print</span>
            <span className="value">{fmtNumber(analytics.largestTrade?.notional || 0)} USDC</span>
            <span className="label truncate">
              {analytics.largestTrade?.question || "No qualifying trades in this view"}
            </span>
          </article>
        </div>
        <div className="analytics-columns">
          <div className="analytics-card">
            <div className="stream-header">
              <h4>Trade Leaders</h4>
              <span>{analytics.tradeLeaders.length}</span>
            </div>
            <div className="stream-list">
              {analytics.tradeLeaders.length === 0 && (
                <div className="stream-empty">No qualifying large-trade flow in this filter yet.</div>
              )}
              {analytics.tradeLeaders.map((leader) => (
                <div className="analytics-row" key={leader.marketId}>
                  <span className="truncate">{leader.question}</span>
                  <span className="mono">{fmtNumber(leader.totalNotional)} USDC</span>
                  <span className="mono">{leader.tradeCount} trades</span>
                </div>
              ))}
            </div>
          </div>
          <div className="analytics-card">
            <div className="stream-header">
              <h4>Outcome Flow</h4>
              <span>{analytics.outcomeLeaders.length}</span>
            </div>
            <div className="stream-list">
              {analytics.outcomeLeaders.length === 0 && (
                <div className="stream-empty">Outcome-level flow will appear once trades qualify.</div>
              )}
              {analytics.outcomeLeaders.map((entry) => (
                <div className="analytics-row" key={entry.outcome}>
                  <span>{entry.outcome}</span>
                  <span className="mono">{fmtNumber(entry.notional)} USDC</span>
                </div>
              ))}
            </div>
          </div>
          <div className="analytics-card">
            <div className="stream-header">
              <h4>Volume Leaders</h4>
              <span>{analytics.volumeLeaders.length}</span>
            </div>
            <div className="stream-list">
              {analytics.volumeLeaders.map((leader) => (
                <div className="analytics-row" key={leader.marketId}>
                  <span className="truncate">{leader.question}</span>
                  <span className="mono">{fmtNumber(leader.volume24hr)} vol</span>
                  <span className="mono">{fmtNumber(leader.liquidity)} liq</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </details>
      {authToken && (
        <details className="wallet-panel" open>
          <summary className="collapsible-summary">
            <h3>Linked Wallets</h3>
            <button className="btn" type="button" onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              connectAndLinkWallet();
            }} disabled={walletLoading}>
              {walletLoading ? "Connecting..." : "Connect Wallet"}
            </button>
          </summary>
          <div className="micro-disclaimer">
            Wallet connection and trading features are still experimental.
          </div>
          {walletError && <div className="history-error">{walletError}</div>}
          <div className="stream-list">
            {linkedWallets.length === 0 && (
              <div className="stream-empty">No linked wallets yet.</div>
            )}
            {linkedWallets.map((wallet) => (
              <div className="wallet-row" key={wallet.wallet_address}>
                <span className="mono truncate">{wallet.wallet_address}</span>
                <span className="pill">{wallet.is_primary ? "Primary" : "Secondary"}</span>
                {!wallet.is_primary && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setPrimaryWallet(wallet.wallet_address)}
                  >
                    Set Primary
                  </button>
                )}
                <button
                  className="btn"
                  type="button"
                  onClick={() => unlinkWallet(wallet.wallet_address)}
                >
                  Unlink
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

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

          <div className="trading-panel">
            <div className="stream-header">
              <h3>Trading</h3>
              <div className="trade-header-actions">
                <span className="pill">{tradingStatus}</span>
                <button className="btn" type="button" onClick={activateTrading}>
                  {tradingClient ? "Reconnect Wallet" : "Enable Trading"}
                </button>
                {tradingClient && (
                  <button className="btn" type="button" onClick={loadTradingData} disabled={tradingLoading}>
                    {tradingLoading ? "Refreshing..." : "Refresh"}
                  </button>
                )}
              </div>
            </div>
            {!authToken && (
              <div className="stream-empty">Login and link a wallet to place bets from this app.</div>
            )}
            {authToken && !linkedWallets.length && (
              <div className="stream-empty">Link a wallet above before you can place orders.</div>
            )}
            {authToken && linkedWallets.length > 0 && (
              <>
                <div className="active-filter">
                  Linked primary wallet: {primaryWallet?.wallet_address || "-"}
                </div>
                {tradingWalletAddress && (
                  <div className="active-filter">
                    Active trading wallet: {tradingWalletAddress}
                  </div>
                )}
                {tradingNotice && <div className="trade-notice">{tradingNotice}</div>}
                {tradingError && <div className="history-error">{tradingError}</div>}
                <div className="trade-grid">
                  <label className="trade-field">
                    <span className="label">Outcome</span>
                    <select
                      value={selectedTradingToken?.outcome || ""}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, outcome: e.target.value }))}
                      disabled={!selectedMarketTokens.length}
                    >
                      {selectedMarketTokens.map((token) => (
                        <option key={token.tokenId} value={token.outcome}>
                          {token.outcome}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="trade-field">
                    <span className="label">Side</span>
                    <select
                      value={orderForm.side}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, side: e.target.value }))}
                    >
                      <option value={TRADING_SIDE.BUY}>BUY</option>
                      <option value={TRADING_SIDE.SELL}>SELL</option>
                    </select>
                  </label>
                  <label className="trade-field">
                    <span className="label">Price</span>
                    <input
                      type="number"
                      min="0.001"
                      max="0.999"
                      step={marketMeta.tickSize || "0.001"}
                      value={orderForm.price}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, price: e.target.value }))}
                    />
                  </label>
                  <label className="trade-field">
                    <span className="label">Size</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={orderForm.size}
                      onChange={(e) => setOrderForm((prev) => ({ ...prev, size: e.target.value }))}
                    />
                  </label>
                </div>
                <div className="trade-summary">
                  <div>
                    <span className="label">Token ID</span>
                    <span className="value mono">{selectedTradingToken?.tokenId || "-"}</span>
                  </div>
                  <div>
                    <span className="label">Notional</span>
                    <span className="value">{formatMaybeNumber(requiredUsdc, 2)} USDC</span>
                  </div>
                  <div>
                    <span className="label">Tick Size</span>
                    <span className="value">{marketMeta.tickSize || "-"}</span>
                  </div>
                  <div>
                    <span className="label">Neg Risk</span>
                    <span className="value">{marketMeta.tickSize ? String(Boolean(marketMeta.negRisk)) : "-"}</span>
                  </div>
                  <div>
                    <span className="label">Last Trade</span>
                    <span className="value">{formatMaybeNumber(marketMeta.lastTradePrice, 3)}</span>
                  </div>
                </div>
                <div className="trade-summary">
                  <div>
                    <span className="label">USDC Balance / Allowance</span>
                    <span className="value">
                      {formatMaybeNumber(balanceState.collateralBalance, 2)} / {formatMaybeNumber(balanceState.collateralAllowance, 2)}
                    </span>
                  </div>
                  <div>
                    <span className="label">{selectedTradingToken?.outcome || "Outcome"} Balance / Allowance</span>
                    <span className="value">
                      {formatMaybeNumber(balanceState.conditionalBalance, 2)} / {formatMaybeNumber(balanceState.conditionalAllowance, 2)}
                    </span>
                  </div>
                </div>
                <div className="trade-actions">
                  {needsCollateralApproval && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => updateAllowance(TRADING_ASSET_TYPE.COLLATERAL)}
                      disabled={approvalLoading === TRADING_ASSET_TYPE.COLLATERAL}
                    >
                      {approvalLoading === TRADING_ASSET_TYPE.COLLATERAL ? "Approving..." : "Approve USDC"}
                    </button>
                  )}
                  {needsConditionalApproval && (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => updateAllowance(TRADING_ASSET_TYPE.CONDITIONAL)}
                      disabled={approvalLoading === TRADING_ASSET_TYPE.CONDITIONAL}
                    >
                      {approvalLoading === TRADING_ASSET_TYPE.CONDITIONAL ? "Approving..." : `Approve ${selectedTradingToken?.outcome || "Outcome"}`}
                    </button>
                  )}
                  <button
                    className="btn"
                    type="button"
                    onClick={submitOrder}
                    disabled={!canSubmitOrder || orderSubmitting}
                  >
                    {orderSubmitting ? "Submitting..." : `${orderForm.side} ${selectedTradingToken?.outcome || "Order"}`}
                  </button>
                </div>
                {(insufficientCollateral || insufficientShares || needsCollateralApproval || needsConditionalApproval) && (
                  <div className="trade-warning">
                    {insufficientCollateral && <div>USDC balance is below the required notional.</div>}
                    {insufficientShares && <div>Outcome token balance is below the order size.</div>}
                    {needsCollateralApproval && <div>USDC allowance must cover the order notional.</div>}
                    {needsConditionalApproval && <div>Outcome token allowance must cover the sell size.</div>}
                  </div>
                )}
                <div className="trade-books">
                  <div className="trade-book">
                    <div className="stream-header">
                      <h4>Open Orders</h4>
                      <span>{openOrders.length}</span>
                    </div>
                    <div className="stream-list">
                      {openOrders.length === 0 && <div className="stream-empty">No open orders for this market.</div>}
                      {openOrders.map((order) => (
                        <div className="trade-book-row" key={order.id}>
                          <span className="mono">{order.outcome || "?"} {order.side}</span>
                          <span className="mono">{formatMaybeNumber(order.original_size, 2)} @ {formatMaybeNumber(order.price, 3)}</span>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => cancelOpenOrder(order.id)}
                            disabled={cancelingOrderId === order.id}
                          >
                            {cancelingOrderId === order.id ? "Canceling..." : "Cancel"}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="trade-book">
                    <div className="stream-header">
                      <h4>Recent Fills</h4>
                      <span>{userFills.length}</span>
                    </div>
                    <div className="stream-list">
                      {userFills.length === 0 && <div className="stream-empty">No recent fills for this market.</div>}
                      {userFills.map((trade) => (
                        <div className="trade-book-row" key={trade.id}>
                          <span className="mono">{trade.outcome || "?"} {trade.side}</span>
                          <span className="mono">{formatMaybeNumber(trade.size, 2)} @ {formatMaybeNumber(trade.price, 3)}</span>
                          <span className="mono">{new Date(trade.match_time).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="market-history">
            <div className="stream-header">
              <h3>Large Trade History</h3>
              <span>{selectedHistoryVisibleItems.length} shown</span>
            </div>
            <div className="stream-list">
              {selectedHistoryVisibleItems.length === 0 && !selectedHistory.loading && (
                <div className="stream-empty">No trades meet the minimum USDC threshold yet.</div>
              )}
              {selectedHistoryVisibleItems.map((trade, idx) => (
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
              {selectedMarket && (
                <div className="alert-config">
                  <span className="label">Alert Threshold (USDC)</span>
                  <input
                    className="min-usdc-input"
                    type="number"
                    min="0"
                    step="100"
                    value={Number(alertsByMarketId[selectedMarket._key]?.min_notional_usdc || minLargeTradeUsdc)}
                    onChange={(e) =>
                      upsertAlert(
                        selectedMarket._key,
                        Number(e.target.value || 0),
                        true
                      )
                    }
                  />
                  {alertsByMarketId[selectedMarket._key] ? (
                    <button className="btn" type="button" onClick={() => removeAlert(selectedMarket._key)}>
                      Disable Alert
                    </button>
                  ) : (
                    <button
                      className="btn"
                      type="button"
                      onClick={() => upsertAlert(selectedMarket._key, minLargeTradeUsdc, true)}
                    >
                      Enable Alert
                    </button>
                  )}
                </div>
              )}
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
          const isBookmarked = Boolean(bookmarksByMarketId[market._key]);
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
                <div className="card-header-actions">
                  <button
                    type="button"
                    className={`pill-btn ${isBookmarked ? "active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleBookmark(market);
                    }}
                  >
                    {isBookmarked ? "Bookmarked" : "Bookmark"}
                  </button>
                  <span className="pill">
                    {market.endDate ? new Date(market.endDate).toLocaleDateString() : "No end"}
                  </span>
                </div>
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
          <span>{filteredLargeTrades.length} events</span>
        </div>
        <div className="active-filter">Active filter: {activeCategoryLabel}</div>
        {excludedCategoryLabels.length > 0 && (
          <div className="active-filter">Excluded: {excludedCategoryLabels.join(", ")}</div>
        )}
        {authToken && (
          <div className="active-filter">Alert matches: {alertMatches.length}</div>
        )}
        <div className="stream-col-header" aria-hidden="true">
          <span className="mono">Time - execution timestamp</span>
          <span>Market - question traded</span>
          <span className="mono">Side - outcome and direction</span>
          <span className="mono">Size @ Price - contracts at fill price</span>
          <span className="mono">Notional - total USDC value</span>
        </div>
        <div className="stream-list">
          {filteredLargeTrades.length === 0 && <div className="stream-empty">No large trades for this filter yet.</div>}
          {filteredLargeTrades.map((trade, idx) => (
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
      {authToken && (
        <section className="stream">
          <div className="stream-header">
            <h3>Alert Matches</h3>
            <span>{alertMatches.length} events</span>
          </div>
          <div className="stream-list">
            {alertMatches.length === 0 && <div className="stream-empty">No alert matches yet.</div>}
            {alertMatches.slice(0, 20).map((trade, idx) => (
              <div className="stream-row" key={`alert-${trade.asset_id}-${trade.timestamp}-${idx}`}>
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
      )}
      <footer className="page-footer">
        <span>Polymarket Watch</span>
        <span>Live analytics, large-trade monitoring, and trading tools.</span>
        <span>Contact Us: polywatchsupport@gmail.com</span>
        <span className="micro-disclaimer">
          Disclaimer: This site is for informational purposes only and does not provide financial advice.
        </span>
      </footer>
    </div>
  );
}
