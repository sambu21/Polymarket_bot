import websockets
import json
import asyncio
from db import insert_trade

WS_URL = "wss://clob.polymarket.com/ws"

async def listen(pool):
    async with websockets.connect(WS_URL) as ws:
        print("Connected to Polymarket WebSocket")

        # Subscribe to trades
        subscribe_message = {
            "type": "subscribe",
            "channels": ["trades"]
        }
        await ws.send(json.dumps(subscribe_message))

        while True:
            message = await ws.recv()
            data = json.loads(message)

            if data.get("type") == "trade":
                token_id = data["token_id"]
                price = float(data["price"])
                size = float(data["size"])
                timestamp = data["timestamp"]

                await insert_trade(pool, token_id, price, size, timestamp)
