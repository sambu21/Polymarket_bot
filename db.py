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
