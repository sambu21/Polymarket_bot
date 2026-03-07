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
