import asyncio
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Set

from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from .clob_streamer import LargeTradeStream, TokenMapCache
try:
    from db import (
        add_user_bookmark,
        connect_db,
        create_user,
        get_large_trades_for_market,
        get_recent_large_trades,
        get_user_preferences,
        get_user_by_email,
        init_db,
        insert_large_trade,
        list_user_alerts,
        list_user_bookmarks,
        purge_old_large_trades,
        remove_user_alert,
        remove_user_bookmark,
        upsert_user_alert,
        upsert_user_preferences,
    )
except Exception:
    add_user_bookmark = None
    connect_db = None
    create_user = None
    get_large_trades_for_market = None
    get_recent_large_trades = None
    get_user_preferences = None
    get_user_by_email = None
    init_db = None
    insert_large_trade = None
    list_user_alerts = None
    list_user_bookmarks = None
    purge_old_large_trades = None
    remove_user_alert = None
    remove_user_bookmark = None
    upsert_user_alert = None
    upsert_user_preferences = None

FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
AUTH_SECRET_KEY = os.getenv("AUTH_SECRET_KEY", "change-this-secret")
AUTH_ALGORITHM = "HS256"
AUTH_EXPIRE_HOURS = int(os.getenv("AUTH_EXPIRE_HOURS", "168"))
LARGE_TRADE_RETENTION_HOURS = int(os.getenv("LARGE_TRADE_RETENTION_HOURS", "48"))
LARGE_TRADE_CLEANUP_SECONDS = int(os.getenv("LARGE_TRADE_CLEANUP_SECONDS", "600"))

app = FastAPI(title="Polymarket Monitor API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

cache = TokenMapCache()
db_pool = None
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
bearer_scheme = HTTPBearer(auto_error=False)


class AuthPayload(BaseModel):
    email: str
    password: str


class UserPreferencesPayload(BaseModel):
    default_category_slug: str | None = None
    min_large_trade_usdc: float = 5000


class BookmarkPayload(BaseModel):
    market_id: str
    question: str | None = None


class AlertPayload(BaseModel):
    market_id: str
    min_notional_usdc: float = 5000
    enabled: bool = True


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _issue_access_token(user: dict) -> str:
    exp = datetime.now(timezone.utc) + timedelta(hours=AUTH_EXPIRE_HOURS)
    payload = {
        "sub": user["email"],
        "uid": str(user["id"]),
        "exp": exp,
    }
    return jwt.encode(payload, AUTH_SECRET_KEY, algorithm=AUTH_ALGORITHM)


async def _current_user_from_token(token: str) -> dict:
    if not token:
        raise HTTPException(status_code=401, detail="Missing auth token")
    try:
        payload = jwt.decode(token, AUTH_SECRET_KEY, algorithms=[AUTH_ALGORITHM])
        email = _normalize_email(payload.get("sub"))
    except JWTError:
        raise HTTPException(status_code=401, detail="Invalid auth token")
    if not email:
        raise HTTPException(status_code=401, detail="Invalid auth token")
    if db_pool is None or get_user_by_email is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    user = await get_user_by_email(db_pool, email)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def require_user(credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme)) -> dict:
    token = credentials.credentials if credentials else ""
    return await _current_user_from_token(token)


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


def _normalize_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _slugify(value: str | None) -> str | None:
    text = _normalize_text(value)
    if not text:
        return None
    return text.lower().replace("&", "and").replace(" ", "-")


def _extract_market_category(market: dict) -> tuple[str | None, str | None]:
    preferred_slugs = {
        "politics",
        "sports",
        "crypto",
        "pop-culture",
        "business",
        "science",
        "world",
        "technology",
        "ai",
        "entertainment",
        "economy",
    }

    def _iter_tags(raw_tags):
        tags = raw_tags
        if isinstance(tags, str):
            try:
                tags = json.loads(tags)
            except Exception:
                tags = []
        if not isinstance(tags, list):
            return
        for tag in tags:
            if isinstance(tag, dict):
                name = _normalize_text(tag.get("label")) or _normalize_text(tag.get("name"))
                slug = _normalize_text(tag.get("slug")) or _slugify(name)
            else:
                name = _normalize_text(tag)
                slug = _slugify(name)
            if name or slug:
                yield name, slug

    direct_name = (
        _normalize_text(market.get("category"))
        or _normalize_text(market.get("categoryName"))
        or _normalize_text(market.get("eventCategory"))
    )
    direct_slug = (
        _normalize_text(market.get("categorySlug"))
        or _normalize_text(market.get("eventCategorySlug"))
    )

    event = market.get("event")
    if isinstance(event, dict):
        direct_name = direct_name or _normalize_text(event.get("category"))
        direct_slug = direct_slug or _normalize_text(event.get("categorySlug"))
        for tag_name, tag_slug in _iter_tags(event.get("tags")):
            if tag_slug in preferred_slugs:
                return tag_name or tag_slug, tag_slug

    events = market.get("events")
    if isinstance(events, list):
        for ev in events:
            if not isinstance(ev, dict):
                continue
            direct_name = direct_name or _normalize_text(ev.get("category"))
            direct_slug = direct_slug or _normalize_text(ev.get("categorySlug"))
            for tag_name, tag_slug in _iter_tags(ev.get("tags")):
                if tag_slug in preferred_slugs:
                    return tag_name or tag_slug, tag_slug
            if direct_name or direct_slug:
                break

    if direct_name or direct_slug:
        return direct_name or direct_slug, direct_slug or _slugify(direct_name)

    for name, slug in _iter_tags(market.get("tags")):
        if slug in preferred_slugs:
            return name or slug, slug

    return None, None


@app.on_event("startup")
async def on_startup() -> None:
    global db_pool
    if connect_db and init_db:
        db_pool = await connect_db()
        await init_db(db_pool)

    await cache.update()

    async def refresh_loop() -> None:
        while True:
            try:
                await cache.update()
            except Exception as exc:
                print(f"Market refresh failed: {exc}")
            await asyncio.sleep(int(os.getenv("MARKET_REFRESH_SECONDS", "60")))

    async def trade_loop() -> None:
        async def handle_large_trade(payload: dict) -> None:
            if db_pool is not None and insert_large_trade is not None:
                ts = payload.get("timestamp")
                observed_at = datetime.now(timezone.utc)
                if isinstance(ts, str) and ts.strip():
                    try:
                        observed_at = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    except ValueError:
                        pass

                await insert_large_trade(
                    db_pool,
                    payload.get("asset_id"),
                    payload.get("market_id"),
                    payload.get("question"),
                    payload.get("outcome"),
                    payload.get("side"),
                    float(payload.get("price") or 0),
                    float(payload.get("size") or 0),
                    float(payload.get("notional") or 0),
                    observed_at,
                )

            await hub.broadcast(payload)

        stream = LargeTradeStream(cache, handle_large_trade)
        await stream.run()

    async def retention_loop() -> None:
        while True:
            if db_pool is not None and purge_old_large_trades is not None:
                deleted = await purge_old_large_trades(db_pool, LARGE_TRADE_RETENTION_HOURS)
                if deleted:
                    print(f"Purged {deleted} large trades older than {LARGE_TRADE_RETENTION_HOURS} hours")
            await asyncio.sleep(max(60, LARGE_TRADE_CLEANUP_SECONDS))

    asyncio.create_task(refresh_loop())
    asyncio.create_task(trade_loop())
    asyncio.create_task(retention_loop())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global db_pool
    if db_pool is not None:
        await db_pool.close()
        db_pool = None


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "time": datetime.utcnow().isoformat() + "Z"}


@app.post("/api/auth/register")
async def auth_register(payload: AuthPayload) -> dict:
    if db_pool is None or create_user is None or get_user_by_email is None:
        raise HTTPException(status_code=503, detail="Database unavailable")

    email = _normalize_email(payload.email)
    password = payload.password or ""
    if "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    existing = await get_user_by_email(db_pool, email)
    if existing:
        raise HTTPException(status_code=409, detail="Email already registered")

    password_hash = pwd_context.hash(password)
    created = await create_user(db_pool, email, password_hash)
    if not created:
        raise HTTPException(status_code=500, detail="Could not create user")

    token = _issue_access_token(created)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": created["id"],
            "email": created["email"],
        },
    }


@app.post("/api/auth/login")
async def auth_login(payload: AuthPayload) -> dict:
    if db_pool is None or get_user_by_email is None:
        raise HTTPException(status_code=503, detail="Database unavailable")

    email = _normalize_email(payload.email)
    user = await get_user_by_email(db_pool, email)
    if not user or not pwd_context.verify(payload.password or "", user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token = _issue_access_token(user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "email": user["email"],
        },
    }


@app.get("/api/auth/me")
async def auth_me(user: dict = Depends(require_user)) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
    }


@app.get("/api/user/preferences")
async def user_preferences(user: dict = Depends(require_user)) -> dict:
    if db_pool is None or get_user_preferences is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    prefs = await get_user_preferences(db_pool, user["id"])
    return prefs or {
        "default_category_slug": None,
        "min_large_trade_usdc": 5000,
    }


@app.put("/api/user/preferences")
async def user_preferences_update(payload: UserPreferencesPayload, user: dict = Depends(require_user)) -> dict:
    if db_pool is None or upsert_user_preferences is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    min_usdc = max(0, float(payload.min_large_trade_usdc or 0))
    category_slug = (payload.default_category_slug or "").strip().lower() or None
    saved = await upsert_user_preferences(db_pool, user["id"], category_slug, min_usdc)
    if not saved:
        raise HTTPException(status_code=500, detail="Could not save preferences")
    return saved


@app.get("/api/user/bookmarks")
async def user_bookmarks(user: dict = Depends(require_user)) -> dict:
    if db_pool is None or list_user_bookmarks is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    items = await list_user_bookmarks(db_pool, user["id"])
    return {"bookmarks": items}


@app.post("/api/user/bookmarks")
async def user_bookmarks_add(payload: BookmarkPayload, user: dict = Depends(require_user)) -> dict:
    if db_pool is None or add_user_bookmark is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    market_id = (payload.market_id or "").strip()
    if not market_id:
        raise HTTPException(status_code=400, detail="market_id is required")
    ok = await add_user_bookmark(db_pool, user["id"], market_id, payload.question)
    if not ok:
        raise HTTPException(status_code=500, detail="Could not save bookmark")
    return {"ok": True}


@app.delete("/api/user/bookmarks/{market_id}")
async def user_bookmarks_remove(market_id: str, user: dict = Depends(require_user)) -> dict:
    if db_pool is None or remove_user_bookmark is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    ok = await remove_user_bookmark(db_pool, user["id"], market_id)
    if not ok:
        raise HTTPException(status_code=500, detail="Could not remove bookmark")
    return {"ok": True}


@app.get("/api/user/alerts")
async def user_alerts(user: dict = Depends(require_user)) -> dict:
    if db_pool is None or list_user_alerts is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    items = await list_user_alerts(db_pool, user["id"])
    return {"alerts": items}


@app.post("/api/user/alerts")
async def user_alerts_upsert(payload: AlertPayload, user: dict = Depends(require_user)) -> dict:
    if db_pool is None or upsert_user_alert is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    market_id = (payload.market_id or "").strip()
    if not market_id:
        raise HTTPException(status_code=400, detail="market_id is required")
    min_notional = max(0, float(payload.min_notional_usdc or 0))
    ok = await upsert_user_alert(db_pool, user["id"], market_id, min_notional, payload.enabled)
    if not ok:
        raise HTTPException(status_code=500, detail="Could not save alert")
    return {"ok": True}


@app.delete("/api/user/alerts/{market_id}")
async def user_alerts_remove(market_id: str, user: dict = Depends(require_user)) -> dict:
    if db_pool is None or remove_user_alert is None:
        raise HTTPException(status_code=503, detail="Database unavailable")
    ok = await remove_user_alert(db_pool, user["id"], market_id)
    if not ok:
        raise HTTPException(status_code=500, detail="Could not remove alert")
    return {"ok": True}


@app.get("/api/markets")
async def markets() -> dict:
    snapshot = await cache.get_snapshot()
    markets = []
    for m in snapshot["markets"]:
        category, category_slug = _extract_market_category(m)
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
            "category": category,
            "categorySlug": category_slug,
        })
    return {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "markets": markets,
    }


@app.get("/api/markets/{market_id}/large-trades")
async def market_large_trades(
    market_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    if db_pool is None or get_large_trades_for_market is None:
        return {
            "market_id": market_id,
            "limit": limit,
            "offset": offset,
            "has_more": False,
            "trades": [],
        }

    rows = await get_large_trades_for_market(
        db_pool,
        market_id=market_id,
        limit=limit + 1,
        offset=offset,
    )
    has_more = len(rows) > limit
    trades = rows[:limit]
    return {
        "market_id": market_id,
        "limit": limit,
        "offset": offset,
        "has_more": has_more,
        "trades": trades,
    }


@app.get("/api/large-trades")
async def large_trades(
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    if db_pool is None or get_recent_large_trades is None:
        return {
            "limit": limit,
            "trades": [],
        }
    trades = await get_recent_large_trades(db_pool, limit=limit)
    return {
        "limit": limit,
        "trades": trades,
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
