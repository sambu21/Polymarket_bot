import os

try:
    import asyncpg
except Exception:
    asyncpg = None

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    # dotenv is optional; env vars can be set by other means.
    pass

REQUIRED_ENV_VARS = [
    "DB_HOST",
    "DB_PORT",
    "DB_NAME",
    "DB_USER",
    "DB_PASSWORD",
]

async def connect_db():
    if asyncpg is None:
        print("DB disabled: asyncpg is not installed.")
        return None

    missing = [k for k in REQUIRED_ENV_VARS if not os.getenv(k)]
    if missing:
        print(f"DB disabled: missing env vars: {', '.join(missing)}")
        return None

    try:
        return await asyncpg.create_pool(
            host=os.getenv("DB_HOST"),
            port=os.getenv("DB_PORT"),
            database=os.getenv("DB_NAME"),
            user=os.getenv("DB_USER"),
            password=os.getenv("DB_PASSWORD")
        )
    except Exception as exc:
        print(f"DB disabled: failed to connect: {exc}")
        return None

async def insert_trade(pool, token_id, price, size, timestamp):
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO trades(token_id, price, size, timestamp)
                VALUES($1, $2, $3, $4)
                """,
                token_id, price, size, timestamp
            )
    except Exception as exc:
        print(f"DB insert failed: {exc}")

async def init_db(pool):
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS market_volume_snapshots (
                    market_id TEXT NOT NULL,
                    volume_24h NUMERIC NOT NULL,
                    observed_at TIMESTAMPTZ NOT NULL,
                    PRIMARY KEY (market_id, observed_at)
                );
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS volume_spikes (
                    market_id TEXT NOT NULL,
                    question TEXT,
                    delta NUMERIC NOT NULL,
                    window_seconds INTEGER NOT NULL,
                    observed_at TIMESTAMPTZ NOT NULL
                );
                """
            )
            await conn.execute(
                """
                CREATE INDEX IF NOT EXISTS volume_spikes_market_time_idx
                ON volume_spikes(market_id, observed_at DESC);
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS large_trades (
                    asset_id TEXT NOT NULL,
                    market_id TEXT,
                    question TEXT,
                    outcome TEXT,
                    side TEXT,
                    price NUMERIC NOT NULL,
                    size NUMERIC NOT NULL,
                    notional NUMERIC NOT NULL,
                    observed_at TIMESTAMPTZ NOT NULL
                );
                """
            )
            await conn.execute(
                """
                CREATE INDEX IF NOT EXISTS large_trades_market_time_idx
                ON large_trades(market_id, observed_at DESC);
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id BIGSERIAL PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
            await conn.execute(
                """
                CREATE INDEX IF NOT EXISTS users_email_idx
                ON users(email);
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_preferences (
                    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    default_category_slug TEXT,
                    min_large_trade_usdc NUMERIC NOT NULL DEFAULT 5000,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                );
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_bookmarks (
                    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    market_id TEXT NOT NULL,
                    question TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (user_id, market_id)
                );
                """
            )
            await conn.execute(
                """
                CREATE INDEX IF NOT EXISTS user_bookmarks_user_created_idx
                ON user_bookmarks(user_id, created_at DESC);
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_market_alerts (
                    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    market_id TEXT NOT NULL,
                    min_notional_usdc NUMERIC NOT NULL DEFAULT 5000,
                    enabled BOOLEAN NOT NULL DEFAULT TRUE,
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (user_id, market_id)
                );
                """
            )
            await conn.execute(
                """
                CREATE INDEX IF NOT EXISTS user_market_alerts_user_enabled_idx
                ON user_market_alerts(user_id, enabled);
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_wallets (
                    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    wallet_address TEXT NOT NULL,
                    verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
                    PRIMARY KEY (user_id, wallet_address)
                );
                """
            )
            await conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS user_wallets_primary_unique_idx
                ON user_wallets(user_id)
                WHERE is_primary = TRUE;
                """
            )
            await conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_wallet_nonces (
                    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    wallet_address TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    PRIMARY KEY (user_id, wallet_address)
                );
                """
            )
    except Exception as exc:
        print(f"DB init failed: {exc}")

async def insert_volume_snapshot(pool, market_id, volume_24h, observed_at):
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO market_volume_snapshots(market_id, volume_24h, observed_at)
                VALUES($1, $2, $3)
                """,
                market_id, volume_24h, observed_at
            )
    except Exception as exc:
        print(f"DB insert snapshot failed: {exc}")

async def insert_volume_spike(pool, market_id, question, delta, window_seconds, observed_at):
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO volume_spikes(market_id, question, delta, window_seconds, observed_at)
                VALUES($1, $2, $3, $4, $5)
                """,
                market_id, question, delta, window_seconds, observed_at
            )
    except Exception as exc:
        print(f"DB insert spike failed: {exc}")

async def insert_large_trade(pool, asset_id, market_id, question, outcome, side, price, size, notional, observed_at):
    if pool is None:
        return
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO large_trades(
                    asset_id, market_id, question, outcome, side, price, size, notional, observed_at
                )
                VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                asset_id, market_id, question, outcome, side, price, size, notional, observed_at
            )
    except Exception as exc:
        print(f"DB insert large trade failed: {exc}")

async def get_recent_volume(pool, token_id, minutes=2):
    if pool is None:
        return 0
    try:
        async with pool.acquire() as conn:
            result = await conn.fetchval(
                """
                SELECT COALESCE(SUM(size), 0)
                FROM trades
                WHERE token_id = $1
                AND timestamp > NOW() - make_interval(mins => $2)
                """,
                token_id, minutes
            )
            return result or 0
    except Exception as exc:
        print(f"DB query failed: {exc}")
        return 0


async def get_large_trades_for_market(pool, market_id, limit=50, offset=0):
    if pool is None:
        return []
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    asset_id,
                    market_id,
                    question,
                    outcome,
                    side,
                    price,
                    size,
                    notional,
                    observed_at
                FROM large_trades
                WHERE market_id = $1
                AND observed_at >= NOW() - INTERVAL '48 hours'
                ORDER BY observed_at DESC
                LIMIT $2
                OFFSET $3
                """,
                market_id,
                limit,
                offset,
            )
            result = []
            for row in rows:
                ts = row["observed_at"]
                iso = ts.isoformat()
                if iso.endswith("+00:00"):
                    iso = iso[:-6] + "Z"
                result.append(
                    {
                        "asset_id": row["asset_id"],
                        "market_id": row["market_id"],
                        "question": row["question"],
                        "outcome": row["outcome"],
                        "side": row["side"],
                        "price": float(row["price"] or 0),
                        "size": float(row["size"] or 0),
                        "notional": float(row["notional"] or 0),
                        "timestamp": iso,
                    }
                )
            return result
    except Exception as exc:
        print(f"DB large trade query failed: {exc}")
        return []


async def purge_old_large_trades(pool, retention_hours=48):
    if pool is None:
        return 0
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM large_trades
                WHERE observed_at < NOW() - ($1::text || ' hours')::interval
                """,
                str(int(retention_hours)),
            )
            # result format: "DELETE <count>"
            deleted = int(str(result).split()[-1])
            return deleted
    except Exception as exc:
        print(f"DB purge old large trades failed: {exc}")
        return 0


async def get_recent_large_trades(pool, limit=100):
    if pool is None:
        return []
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    asset_id,
                    market_id,
                    question,
                    outcome,
                    side,
                    price,
                    size,
                    notional,
                    observed_at
                FROM large_trades
                WHERE observed_at >= NOW() - INTERVAL '48 hours'
                ORDER BY observed_at DESC
                LIMIT $1
                """,
                limit,
            )
            result = []
            for row in rows:
                ts = row["observed_at"]
                iso = ts.isoformat()
                if iso.endswith("+00:00"):
                    iso = iso[:-6] + "Z"
                result.append(
                    {
                        "asset_id": row["asset_id"],
                        "market_id": row["market_id"],
                        "question": row["question"],
                        "outcome": row["outcome"],
                        "side": row["side"],
                        "price": float(row["price"] or 0),
                        "size": float(row["size"] or 0),
                        "notional": float(row["notional"] or 0),
                        "timestamp": iso,
                    }
                )
            return result
    except Exception as exc:
        print(f"DB recent large trades query failed: {exc}")
        return []


async def get_user_preferences(pool, user_id):
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT default_category_slug, min_large_trade_usdc
                FROM user_preferences
                WHERE user_id = $1
                """,
                user_id,
            )
            if not row:
                return None
            return {
                "default_category_slug": row["default_category_slug"],
                "min_large_trade_usdc": float(row["min_large_trade_usdc"] or 5000),
            }
    except Exception as exc:
        print(f"DB get user preferences failed: {exc}")
        return None


async def upsert_user_preferences(pool, user_id, default_category_slug, min_large_trade_usdc):
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO user_preferences(user_id, default_category_slug, min_large_trade_usdc, updated_at)
                VALUES($1, $2, $3, NOW())
                ON CONFLICT (user_id) DO UPDATE
                SET default_category_slug = EXCLUDED.default_category_slug,
                    min_large_trade_usdc = EXCLUDED.min_large_trade_usdc,
                    updated_at = NOW()
                RETURNING default_category_slug, min_large_trade_usdc
                """,
                user_id,
                default_category_slug,
                float(min_large_trade_usdc),
            )
            if not row:
                return None
            return {
                "default_category_slug": row["default_category_slug"],
                "min_large_trade_usdc": float(row["min_large_trade_usdc"] or 5000),
            }
    except Exception as exc:
        print(f"DB upsert user preferences failed: {exc}")
        return None


async def list_user_bookmarks(pool, user_id):
    if pool is None:
        return []
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT market_id, question, created_at
                FROM user_bookmarks
                WHERE user_id = $1
                ORDER BY created_at DESC
                """,
                user_id,
            )
            return [
                {
                    "market_id": row["market_id"],
                    "question": row["question"],
                    "created_at": row["created_at"].isoformat(),
                }
                for row in rows
            ]
    except Exception as exc:
        print(f"DB list bookmarks failed: {exc}")
        return []


async def add_user_bookmark(pool, user_id, market_id, question):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO user_bookmarks(user_id, market_id, question)
                VALUES($1, $2, $3)
                ON CONFLICT (user_id, market_id) DO UPDATE
                SET question = EXCLUDED.question
                """,
                user_id,
                market_id,
                question,
            )
            return True
    except Exception as exc:
        print(f"DB add bookmark failed: {exc}")
        return False


async def remove_user_bookmark(pool, user_id, market_id):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                DELETE FROM user_bookmarks
                WHERE user_id = $1 AND market_id = $2
                """,
                user_id,
                market_id,
            )
            return True
    except Exception as exc:
        print(f"DB remove bookmark failed: {exc}")
        return False


async def list_user_alerts(pool, user_id):
    if pool is None:
        return []
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT market_id, min_notional_usdc, enabled, updated_at
                FROM user_market_alerts
                WHERE user_id = $1
                ORDER BY updated_at DESC
                """,
                user_id,
            )
            return [
                {
                    "market_id": row["market_id"],
                    "min_notional_usdc": float(row["min_notional_usdc"] or 0),
                    "enabled": bool(row["enabled"]),
                    "updated_at": row["updated_at"].isoformat(),
                }
                for row in rows
            ]
    except Exception as exc:
        print(f"DB list alerts failed: {exc}")
        return []


async def upsert_user_alert(pool, user_id, market_id, min_notional_usdc, enabled=True):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO user_market_alerts(user_id, market_id, min_notional_usdc, enabled, updated_at)
                VALUES($1, $2, $3, $4, NOW())
                ON CONFLICT (user_id, market_id) DO UPDATE
                SET min_notional_usdc = EXCLUDED.min_notional_usdc,
                    enabled = EXCLUDED.enabled,
                    updated_at = NOW()
                """,
                user_id,
                market_id,
                float(min_notional_usdc),
                bool(enabled),
            )
            return True
    except Exception as exc:
        print(f"DB upsert alert failed: {exc}")
        return False


async def remove_user_alert(pool, user_id, market_id):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                DELETE FROM user_market_alerts
                WHERE user_id = $1 AND market_id = $2
                """,
                user_id,
                market_id,
            )
            return True
    except Exception as exc:
        print(f"DB remove alert failed: {exc}")
        return False


async def get_user_wallets(pool, user_id):
    if pool is None:
        return []
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT wallet_address, verified_at, is_primary
                FROM user_wallets
                WHERE user_id = $1
                ORDER BY is_primary DESC, verified_at DESC
                """,
                user_id,
            )
            return [
                {
                    "wallet_address": row["wallet_address"],
                    "verified_at": row["verified_at"].isoformat(),
                    "is_primary": bool(row["is_primary"]),
                }
                for row in rows
            ]
    except Exception as exc:
        print(f"DB get wallets failed: {exc}")
        return []


async def upsert_wallet_nonce(pool, user_id, wallet_address, nonce, expires_at):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO user_wallet_nonces(user_id, wallet_address, nonce, expires_at, created_at)
                VALUES($1, $2, $3, $4, NOW())
                ON CONFLICT (user_id, wallet_address) DO UPDATE
                SET nonce = EXCLUDED.nonce,
                    expires_at = EXCLUDED.expires_at,
                    created_at = NOW()
                """,
                user_id,
                wallet_address,
                nonce,
                expires_at,
            )
            return True
    except Exception as exc:
        print(f"DB upsert wallet nonce failed: {exc}")
        return False


async def consume_wallet_nonce(pool, user_id, wallet_address, nonce):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            result = await conn.execute(
                """
                DELETE FROM user_wallet_nonces
                WHERE user_id = $1
                  AND wallet_address = $2
                  AND nonce = $3
                  AND expires_at > NOW()
                """,
                user_id,
                wallet_address,
                nonce,
            )
            deleted = int(str(result).split()[-1])
            return deleted > 0
    except Exception as exc:
        print(f"DB consume wallet nonce failed: {exc}")
        return False


async def link_user_wallet(pool, user_id, wallet_address):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            has_primary = await conn.fetchval(
                """
                SELECT EXISTS(
                    SELECT 1 FROM user_wallets
                    WHERE user_id = $1 AND is_primary = TRUE
                )
                """,
                user_id,
            )
            await conn.execute(
                """
                INSERT INTO user_wallets(user_id, wallet_address, verified_at, is_primary)
                VALUES($1, $2, NOW(), $3)
                ON CONFLICT (user_id, wallet_address) DO UPDATE
                SET verified_at = NOW()
                """,
                user_id,
                wallet_address,
                not bool(has_primary),
            )
            return True
    except Exception as exc:
        print(f"DB link wallet failed: {exc}")
        return False


async def set_primary_wallet(pool, user_id, wallet_address):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE user_wallets
                SET is_primary = FALSE
                WHERE user_id = $1
                """,
                user_id,
            )
            result = await conn.execute(
                """
                UPDATE user_wallets
                SET is_primary = TRUE
                WHERE user_id = $1 AND wallet_address = $2
                """,
                user_id,
                wallet_address,
            )
            changed = int(str(result).split()[-1])
            return changed > 0
    except Exception as exc:
        print(f"DB set primary wallet failed: {exc}")
        return False


async def remove_user_wallet(pool, user_id, wallet_address):
    if pool is None:
        return False
    try:
        async with pool.acquire() as conn:
            was_primary = await conn.fetchval(
                """
                SELECT is_primary
                FROM user_wallets
                WHERE user_id = $1 AND wallet_address = $2
                """,
                user_id,
                wallet_address,
            )
            result = await conn.execute(
                """
                DELETE FROM user_wallets
                WHERE user_id = $1 AND wallet_address = $2
                """,
                user_id,
                wallet_address,
            )
            deleted = int(str(result).split()[-1])
            if deleted <= 0:
                return False
            if was_primary:
                await conn.execute(
                    """
                    UPDATE user_wallets
                    SET is_primary = TRUE
                    WHERE user_id = $1
                      AND wallet_address = (
                          SELECT wallet_address
                          FROM user_wallets
                          WHERE user_id = $1
                          ORDER BY verified_at DESC
                          LIMIT 1
                      )
                    """,
                    user_id,
                )
            return True
    except Exception as exc:
        print(f"DB remove wallet failed: {exc}")
        return False


async def get_user_by_email(pool, email):
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, email, password_hash, created_at
                FROM users
                WHERE email = $1
                """,
                (email or "").strip().lower(),
            )
            if not row:
                return None
            return {
                "id": int(row["id"]),
                "email": row["email"],
                "password_hash": row["password_hash"],
                "created_at": row["created_at"].isoformat(),
            }
    except Exception as exc:
        print(f"DB get user failed: {exc}")
        return None


async def create_user(pool, email, password_hash):
    if pool is None:
        return None
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO users(email, password_hash)
                VALUES($1, $2)
                RETURNING id, email, created_at
                """,
                (email or "").strip().lower(),
                password_hash,
            )
            if not row:
                return None
            return {
                "id": int(row["id"]),
                "email": row["email"],
                "created_at": row["created_at"].isoformat(),
            }
    except Exception as exc:
        print(f"DB create user failed: {exc}")
        return None
