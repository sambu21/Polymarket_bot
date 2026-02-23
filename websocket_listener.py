import asyncio
import httpx
from datetime import datetime
from db import insert_trade

API_URL = "https://gamma-api.polymarket.com/markets"

TOP_N = 20
POLL_INTERVAL = 30  # seconds

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

                    if market_id in previous_volumes:
                        previous = previous_volumes[market_id]
                        delta = volume_24h - previous

                        # Simple spike rule:
                        if delta > 10000:  # adjust threshold later
                            print(f"VOLUME SPIKE: {market.get('question')}")
                            print(f"Δ Volume: {delta}")

                    previous_volumes[market_id] = volume_24h

                await asyncio.sleep(POLL_INTERVAL)

            except Exception as e:
                print("Scanner error:", e)
                await asyncio.sleep(10)