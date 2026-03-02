import asyncio
import json
import os
from datetime import datetime
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .clob_streamer import LargeTradeStream, TokenMapCache

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

app = FastAPI(title="Polymarket Monitor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

cache = TokenMapCache()


class WebSocketHub:
    def __init__(self) -> None:
        self._clients: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast(self, payload: dict) -> None:
        message = json.dumps(payload)
        async with self._lock:
            clients = list(self._clients)

        if not clients:
            return

        to_remove = []
        for ws in clients:
            try:
                await ws.send_text(message)
            except Exception:
                to_remove.append(ws)

        if to_remove:
            async with self._lock:
                for ws in to_remove:
                    self._clients.discard(ws)


hub = WebSocketHub()


@app.on_event("startup")
async def on_startup() -> None:
    await cache.update()

    async def refresh_loop() -> None:
        while True:
            try:
                await cache.update()
            except Exception as exc:
                print(f"Market refresh failed: {exc}")
            await asyncio.sleep(int(os.getenv("MARKET_REFRESH_SECONDS", "60")))

    async def trade_loop() -> None:
        stream = LargeTradeStream(cache, hub.broadcast)
        await stream.run()

    asyncio.create_task(refresh_loop())
    asyncio.create_task(trade_loop())


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "time": datetime.utcnow().isoformat() + "Z"}


@app.get("/api/markets")
async def markets() -> dict:
    snapshot = await cache.get_snapshot()
    markets = []
    for m in snapshot["markets"]:
        markets.append({
            "id": m.get("id"),
            "question": m.get("question") or m.get("title"),
            "volume24hr": float(m.get("volume24hr", 0) or 0),
            "liquidity": float(m.get("liquidity", 0) or 0),
            "endDate": m.get("endDate"),
            "outcomes": m.get("outcomes"),
            "outcomePrices": m.get("outcomePrices"),
            "clobTokenIds": m.get("clobTokenIds"),
            "conditionId": m.get("conditionId") or m.get("condition_id"),
        })
    return {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "markets": markets,
    }


@app.websocket("/ws/large-trades")
async def large_trades_ws(ws: WebSocket) -> None:
    await hub.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(ws)
    except Exception:
        await hub.disconnect(ws)
