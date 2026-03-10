import pytest
from fastapi import HTTPException

from backend import main


@pytest.mark.asyncio
async def test_auth_register_returns_503_when_db_unavailable(monkeypatch):
    monkeypatch.setattr(main, "db_pool", None)
    monkeypatch.setattr(main, "create_user", object())
    monkeypatch.setattr(main, "get_user_by_email", object())

    with pytest.raises(HTTPException) as exc:
        await main.auth_register(main.AuthPayload(email="user@example.com", password="password123"))

    assert exc.value.status_code == 503
    assert exc.value.detail == "Database unavailable"


@pytest.mark.asyncio
async def test_auth_register_creates_user_and_token(monkeypatch):
    created_user = {"id": 7, "email": "user@example.com", "password_hash": "hashed"}

    async def fake_get_user_by_email(pool, email):
        assert pool == "pool"
        assert email == "user@example.com"
        return None

    async def fake_create_user(pool, email, password_hash):
        assert pool == "pool"
        assert email == "user@example.com"
        assert password_hash == "hashed-password"
        return created_user

    monkeypatch.setattr(main, "db_pool", "pool")
    monkeypatch.setattr(main, "get_user_by_email", fake_get_user_by_email)
    monkeypatch.setattr(main, "create_user", fake_create_user)
    monkeypatch.setattr(main.pwd_context, "hash", lambda password: "hashed-password")
    monkeypatch.setattr(main, "_issue_access_token", lambda user: "issued-token")

    response = await main.auth_register(main.AuthPayload(email="User@example.com", password="password123"))

    assert response["access_token"] == "issued-token"
    assert response["user"] == {"id": 7, "email": "user@example.com"}


@pytest.mark.asyncio
async def test_auth_login_validates_password(monkeypatch):
    user = {"id": 4, "email": "user@example.com", "password_hash": "stored-hash"}

    async def fake_get_user_by_email(pool, email):
        assert pool == "pool"
        assert email == "user@example.com"
        return user

    monkeypatch.setattr(main, "db_pool", "pool")
    monkeypatch.setattr(main, "get_user_by_email", fake_get_user_by_email)
    monkeypatch.setattr(main.pwd_context, "verify", lambda password, hashed: password == "password123" and hashed == "stored-hash")
    monkeypatch.setattr(main, "_issue_access_token", lambda payload: "login-token")

    response = await main.auth_login(main.AuthPayload(email="user@example.com", password="password123"))

    assert response["access_token"] == "login-token"
    assert response["user"]["email"] == "user@example.com"


@pytest.mark.asyncio
async def test_analytics_overview_filters_category_and_trades(monkeypatch):
    async def fake_snapshot():
        return {
            "markets": [
                {
                    "id": "m1",
                    "question": "Politics market",
                    "volume24hr": 1000,
                    "liquidity": 500,
                    "conditionId": "m1",
                    "category": "Politics",
                    "categorySlug": "politics",
                },
                {
                    "id": "m2",
                    "question": "Sports market",
                    "volume24hr": 2000,
                    "liquidity": 900,
                    "conditionId": "m2",
                    "category": "Sports",
                    "categorySlug": "sports",
                },
            ]
        }

    async def fake_recent_large_trades(pool, limit=250):
        assert pool == "pool"
        assert limit == 250
        return [
            {"market_id": "m1", "question": "Politics market", "side": "BUY", "outcome": "YES", "notional": 9000, "timestamp": "2026-03-09T00:00:00Z"},
            {"market_id": "m2", "question": "Sports market", "side": "SELL", "outcome": "NO", "notional": 12000, "timestamp": "2026-03-09T00:00:00Z"},
        ]

    monkeypatch.setattr(main.cache, "get_snapshot", fake_snapshot)
    monkeypatch.setattr(main, "db_pool", "pool")
    monkeypatch.setattr(main, "get_recent_large_trades", fake_recent_large_trades)

    response = await main.analytics_overview(category="politics", min_notional=5000, trade_limit=250)

    assert response["category"] == "politics"
    assert response["analytics"]["marketCount"] == 1
    assert response["analytics"]["totalLargeTradeNotional"] == 9000
    assert response["analytics"]["tradeLeaders"][0]["marketId"] == "m1"
