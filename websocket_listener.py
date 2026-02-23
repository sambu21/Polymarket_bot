import asyncio
import httpx
import os
from datetime import datetime
from db import insert_volume_snapshot, insert_volume_spike

API_URL = "https://gamma-api.polymarket.com/markets"

TOP_N = 20
POLL_INTERVAL = 30  # seconds

# Spike detection config
# Use a hybrid threshold: max(ABSOLUTE_MIN_DELTA, expected_per_window * MULTIPLIER)
ABSOLUTE_MIN_DELTA = float(os.getenv("ABSOLUTE_MIN_DELTA", "10000"))
MULTIPLIER = float(os.getenv("SPIKE_MULTIPLIER", "8"))
MIN_WINDOW_SECONDS = float(os.getenv("SPIKE_MIN_WINDOW_SECONDS", str(POLL_INTERVAL)))


async def listen(pool):
    print("Starting market scanner...")

    previous_volumes = {}

    async with httpx.AsyncClient() as client:
        while True:
            try:
                r = await client.get(API_URL)
                markets = r.json()

                if not isinstance(markets, list):
                    print("Unexpected response:", markets)
                    await asyncio.sleep(10)
                    continue

                # Sort by 24h volume descending
                markets = sorted(
                    markets,
                    key=lambda m: float(m.get("volume24hr", 0)),
                    reverse=True
                )

                top_markets = markets[:TOP_N]

                for market in top_markets:
                    market_id = market.get("id")
                    volume_24h = float(market.get("volume24hr", 0))

                    now = datetime.utcnow()
                    await insert_volume_snapshot(pool, market_id, volume_24h, now)

                    if market_id in previous_volumes:
                        previous = previous_volumes[market_id]
                        delta = volume_24h - previous

                        # Expected delta based on 24h average rate
                        expected_per_sec = (volume_24h / 86400.0) if volume_24h > 0 else 0
                        window_seconds = max(MIN_WINDOW_SECONDS, POLL_INTERVAL)
                        expected_in_window = expected_per_sec * window_seconds
                        threshold = max(ABSOLUTE_MIN_DELTA, expected_in_window * MULTIPLIER)

                        if delta > threshold:
                            print(f"VOLUME SPIKE: {market.get('question')}")
                            print(f"Δ Volume: {delta}")
                            await insert_volume_spike(
                                pool,
                                market_id,
                                market.get("question"),
                                delta,
                                int(window_seconds),
                                now
                            )

                    previous_volumes[market_id] = volume_24h

                await asyncio.sleep(POLL_INTERVAL)

            except Exception as e:
                print("Scanner error:", e)
                await asyncio.sleep(10)
