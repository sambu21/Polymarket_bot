import asyncio
import json
import os
from collections import defaultdict, deque
from datetime import datetime

import httpx

try:
    import websockets
except Exception:
    websockets = None

from db import insert_large_trade


CLOB_WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
GAMMA_API_URL = "https://gamma-api.polymarket.com/markets"
CLOB_API_URL = "https://clob.polymarket.com"

TOP_N = int(os.getenv("TRADE_TOP_N", "20"))

# Large trade detection config
ABSOLUTE_MIN_SIZE = float(os.getenv("TRADE_ABS_MIN_SIZE", "1000"))
WINDOW_SIZE = int(os.getenv("TRADE_SIZE_WINDOW", "50"))
MULTIPLIER = float(os.getenv("TRADE_SIZE_MULTIPLIER", "6"))


async def _fetch_top_markets(client):
    r = await client.get(GAMMA_API_URL)
    markets = r.json()
    if not isinstance(markets, list):
        return []
    markets = sorted(
        markets,
        key=lambda m: float(m.get("volume24hr", 0) or 0),
        reverse=True
    )
    return markets[:TOP_N]


def _extract_tokens_from_gamma(market):
    tokens = market.get("tokens")
    if isinstance(tokens, list) and tokens:
        parsed = []
        for t in tokens:
            token_id = t.get("token_id") or t.get("tokenId")
            outcome = t.get("outcome")
            if token_id and outcome:
                parsed.append({"token_id": token_id, "outcome": outcome})
        if parsed:
            return parsed

    clob_token_ids = market.get("clobTokenIds") or market.get("clob_token_ids")
    outcomes = market.get("outcomes")
    try:
        if isinstance(clob_token_ids, str):
            clob_token_ids = json.loads(clob_token_ids)
        if isinstance(outcomes, str):
            outcomes = json.loads(outcomes)
    except Exception:
        return []

    if isinstance(clob_token_ids, list) and isinstance(outcomes, list):
        if len(clob_token_ids) == len(outcomes):
            return [
                {"token_id": tid, "outcome": out}
                for tid, out in zip(clob_token_ids, outcomes)
                if tid and out
            ]
    return []


async def _fetch_tokens_from_clob(client, condition_id):
    if not condition_id:
        return []

    # Try common REST paths used by the CLOB API.
    for path in (f"/markets/{condition_id}", f"/market/{condition_id}"):
        try:
            r = await client.get(f"{CLOB_API_URL}{path}")
            if r.status_code >= 400:
                continue
            data = r.json()
            tokens = data.get("tokens")
            if isinstance(tokens, list) and tokens:
                parsed = []
                for t in tokens:
                    token_id = t.get("token_id") or t.get("tokenId")
                    outcome = t.get("outcome")
                    if token_id and outcome:
                        parsed.append({"token_id": token_id, "outcome": outcome})
                if parsed:
                    return parsed
        except Exception:
            continue
    return []


async def _build_token_map():
    token_map = {}

    async with httpx.AsyncClient(timeout=15) as client:
        markets = await _fetch_top_markets(client)

        for market in markets:
            question = market.get("question") or market.get("title") or "Unknown market"
            condition_id = market.get("conditionId") or market.get("condition_id")

            tokens = _extract_tokens_from_gamma(market)
            if not tokens:
                tokens = await _fetch_tokens_from_clob(client, condition_id)

            for t in tokens:
                token_map[t["token_id"]] = {
                    "market": condition_id,
                    "question": question,
                    "outcome": t["outcome"],
                }

    return token_map


def _should_alert(token_id, size, recent_sizes):
    sizes = recent_sizes[token_id]
    if not sizes:
        return size >= ABSOLUTE_MIN_SIZE
    avg = sum(sizes) / len(sizes)
    threshold = max(ABSOLUTE_MIN_SIZE, avg * MULTIPLIER)
    return size >= threshold


async def listen_large_trades(pool):
    if websockets is None:
        print("Large trade listener disabled: 'websockets' is not installed.")
        return

    token_map = await _build_token_map()
    if not token_map:
        print("Large trade listener disabled: failed to map token IDs.")
        return

    assets_ids = list(token_map.keys())
    recent_sizes = defaultdict(lambda: deque(maxlen=WINDOW_SIZE))

    print(f"Connecting CLOB market websocket for {len(assets_ids)} assets...")
    async with websockets.connect(CLOB_WSS_URL, ping_interval=20, ping_timeout=20) as ws:
        await ws.send(json.dumps({
            "assets_ids": assets_ids,
            "type": "market",
            "custom_feature_enabled": False
        }))

        while True:
            msg = await ws.recv()
            try:
                data = json.loads(msg)
            except Exception:
                continue

            events = data if isinstance(data, list) else [data]

            for event in events:
                if not isinstance(event, dict):
                    continue
                if event.get("event_type") != "last_trade_price":
                    continue

                token_id = event.get("asset_id")
                price = float(event.get("price") or 0)
                size = float(event.get("size") or 0)
                side = event.get("side")
                ts = event.get("timestamp")

                if not token_id or size <= 0:
                    continue

                if _should_alert(token_id, size, recent_sizes):
                    meta = token_map.get(token_id, {})
                    outcome = (meta.get("outcome") or "Unknown").upper()
                    question = meta.get("question") or "Unknown market"
                    notional = size * price
                    when = datetime.utcfromtimestamp(int(ts) / 1000) if ts else datetime.utcnow()
                    print("LARGE SINGLE TRADE")
                    print(f"Market: {question}")
                    print(f"Outcome: {outcome}  Side: {side}")
                    print(f"Size: {size:.4f}  Price: {price:.4f}  Notional: {notional:.2f} USDC")
                    print(f"Time: {when.isoformat()}Z")

                    await insert_large_trade(
                        pool,
                        token_id,
                        meta.get("market"),
                        question,
                        outcome,
                        side,
                        price,
                        size,
                        notional,
                        when
                    )

                recent_sizes[token_id].append(size)
