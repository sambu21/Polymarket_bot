import asyncio
import json
import os
from collections import defaultdict, deque
from datetime import datetime
from typing import Dict, List

import httpx

try:
    import websockets
except Exception:
    websockets = None

from .polymarket_api import (
    extract_tokens_from_gamma,
    fetch_tokens_from_clob,
    fetch_top_markets,
)

CLOB_WSS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"

# Large trade detection config
ABSOLUTE_MIN_SIZE = float(os.getenv("TRADE_ABS_MIN_SIZE", "1000"))
WINDOW_SIZE = int(os.getenv("TRADE_SIZE_WINDOW", "50"))
MULTIPLIER = float(os.getenv("TRADE_SIZE_MULTIPLIER", "6"))

MARKET_REFRESH_SECONDS = int(os.getenv("MARKET_REFRESH_SECONDS", "60"))


class TokenMapCache:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._token_map: Dict[str, dict] = {}
        self._markets: List[dict] = []

    async def update(self) -> None:
        async with self._lock:
            async with httpx.AsyncClient(timeout=15) as client:
                markets = await fetch_top_markets(client)
                token_map: Dict[str, dict] = {}

                for market in markets:
                    question = market.get("question") or market.get("title") or "Unknown market"
                    condition_id = market.get("conditionId") or market.get("condition_id")

                    tokens = extract_tokens_from_gamma(market)
                    if not tokens:
                        tokens = await fetch_tokens_from_clob(client, condition_id)

                    for t in tokens:
                        token_map[t["token_id"]] = {
                            "market": condition_id,
                            "question": question,
                            "outcome": t["outcome"],
                        }

                self._markets = markets
                self._token_map = token_map

    async def get_snapshot(self) -> dict:
        async with self._lock:
            return {
                "markets": list(self._markets),
                "token_map": dict(self._token_map),
            }


class LargeTradeStream:
    def __init__(self, cache: TokenMapCache, send_callback) -> None:
        self._cache = cache
        self._send = send_callback
        self._recent_sizes = defaultdict(lambda: deque(maxlen=WINDOW_SIZE))

    async def run(self) -> None:
        if websockets is None:
            print("Large trade stream disabled: 'websockets' is not installed.")
            return

        while True:
            snapshot = await self._cache.get_snapshot()
            assets_ids = list(snapshot["token_map"].keys())
            if not assets_ids:
                await asyncio.sleep(5)
                continue

            try:
                async with websockets.connect(
                    CLOB_WSS_URL,
                    ping_interval=20,
                    ping_timeout=20,
                ) as ws:
                    await ws.send(json.dumps({
                        "assets_ids": assets_ids,
                        "type": "market",
                        "custom_feature_enabled": False,
                    }))

                    while True:
                        msg = await ws.recv()
                        await self._handle_message(msg)
            except Exception as exc:
                print(f"Large trade stream reconnecting: {exc}")
                await asyncio.sleep(3)

    async def _handle_message(self, msg: str) -> None:
        try:
            data = json.loads(msg)
        except Exception:
            return

        events = data if isinstance(data, list) else [data]
        snapshot = await self._cache.get_snapshot()
        token_map = snapshot["token_map"]

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

            if self._is_large_trade(token_id, size):
                meta = token_map.get(token_id, {})
                outcome = (meta.get("outcome") or "Unknown").upper()
                question = meta.get("question") or "Unknown market"
                notional = size * price
                when = datetime.utcfromtimestamp(int(ts) / 1000) if ts else datetime.utcnow()

                payload = {
                    "asset_id": token_id,
                    "market_id": meta.get("market"),
                    "question": question,
                    "outcome": outcome,
                    "side": side,
                    "price": price,
                    "size": size,
                    "notional": notional,
                    "timestamp": when.isoformat() + "Z",
                }
                await self._send(payload)

            self._recent_sizes[token_id].append(size)

    def _is_large_trade(self, token_id: str, size: float) -> bool:
        sizes = self._recent_sizes[token_id]
        if not sizes:
            return size >= ABSOLUTE_MIN_SIZE
        avg = sum(sizes) / len(sizes)
        threshold = max(ABSOLUTE_MIN_SIZE, avg * MULTIPLIER)
        return size >= threshold
