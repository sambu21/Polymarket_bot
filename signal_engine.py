import asyncio
from db import get_recent_volume

THRESHOLD_MULTIPLIER = 5
BASELINE_MINUTES = 30
SPIKE_WINDOW = 2


async def monitor(pool, token_id):
    if not token_id or token_id == "REPLACE_WITH_REAL_TOKEN_ID":
        print("Signal engine disabled: token_id is not set.")
        return

    while True:
        recent = await get_recent_volume(pool, token_id, SPIKE_WINDOW)
        baseline = await get_recent_volume(pool, token_id, BASELINE_MINUTES)

        if baseline > 0:
            avg_per_min = baseline / BASELINE_MINUTES
            if recent > THRESHOLD_MULTIPLIER * avg_per_min * SPIKE_WINDOW:
                print(f"Volume spike detected for {token_id}")
                print(f"Recent: {recent}, Baseline avg/min: {avg_per_min}")

        await asyncio.sleep(10)
