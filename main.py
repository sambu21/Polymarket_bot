import asyncio
from db import connect_db
from websocket_listener import listen
from signal_engine import monitor

TOKEN_TO_MONITOR = "REPLACE_WITH_REAL_TOKEN_ID"

async def main():
    pool = await connect_db()

    await asyncio.gather(
        listen(pool),
        monitor(pool, TOKEN_TO_MONITOR)
    )

if __name__ == "__main__":
    asyncio.run(main())
