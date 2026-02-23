import asyncio

from db import connect_db, init_db
from signal_engine import monitor
from websocket_listener import listen

TOKEN_TO_MONITOR = "REPLACE_WITH_REAL_TOKEN_ID"

async def main():
    pool = await connect_db()
    await init_db(pool)

    tasks = []
    tasks.append(listen(pool))

    if TOKEN_TO_MONITOR and TOKEN_TO_MONITOR != "REPLACE_WITH_REAL_TOKEN_ID":
        tasks.append(monitor(pool, TOKEN_TO_MONITOR))
    else:
        print("Skipping signal engine: set TOKEN_TO_MONITOR to enable alerts.")

    if not tasks:
        print("Nothing to run. Exiting.")
        return

    await asyncio.gather(*tasks)

if __name__ == "__main__":
    asyncio.run(main())
