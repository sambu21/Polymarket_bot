import asyncpg
import os
from dotenv import load_dotenv

load_dotenv()

async def connect_db():
    return await asyncpg.create_pool(
        host=os.getenv("DB_HOST"),
        port=os.getenv("DB_PORT"),
        database=os.getenv("DB_NAME"),
        user=os.getenv("DB_USER"),
        password=os.getenv("DB_PASSWORD")
    )

async def insert_trade(pool, token_id, price, size, timestamp):
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO trades(token_id, price, size, timestamp)
            VALUES($1, $2, $3, $4)
            """,
            token_id, price, size, timestamp
        )

async def get_recent_volume(pool, token_id, minutes=2):
    async with pool.acquire() as conn:
        result = await conn.fetchval(
            """
            SELECT COALESCE(SUM(size), 0)
            FROM trades
            WHERE token_id = $1
            AND timestamp > NOW() - ($2 || ' minutes')::INTERVAL
            """,
            token_id, minutes
        )
        return result or 0
