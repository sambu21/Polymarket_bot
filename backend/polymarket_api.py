import json
import os
from typing import List

import httpx

GAMMA_API_URL = "https://gamma-api.polymarket.com/markets"
CLOB_API_URL = "https://clob.polymarket.com"

TOP_N = int(os.getenv("DASH_TOP_N", "50"))


async def fetch_top_markets(client: httpx.AsyncClient) -> List[dict]:
    r = await client.get(GAMMA_API_URL, timeout=15)
    markets = r.json()
    if not isinstance(markets, list):
        return []
    markets = sorted(
        markets,
        key=lambda m: float(m.get("volume24hr", 0) or 0),
        reverse=True,
    )
    return markets[:TOP_N]


def extract_tokens_from_gamma(market: dict) -> List[dict]:
    tokens = market.get("tokens")
    if isinstance(tokens, list) and tokens:
        parsed = []
        for t in tokens:
            token_id = t.get("token_id") or t.get("tokenId")
            outcome = t.get("outcome")
            if token_id and outcome:
                parsed.append({"token_id": token_id, "outcome": outcome})
        if parsed:
            return parsed

    clob_token_ids = market.get("clobTokenIds") or market.get("clob_token_ids")
    outcomes = market.get("outcomes")
    try:
        if isinstance(clob_token_ids, str):
            clob_token_ids = json.loads(clob_token_ids)
        if isinstance(outcomes, str):
            outcomes = json.loads(outcomes)
    except Exception:
        return []

    if isinstance(clob_token_ids, list) and isinstance(outcomes, list):
        if len(clob_token_ids) == len(outcomes):
            return [
                {"token_id": tid, "outcome": out}
                for tid, out in zip(clob_token_ids, outcomes)
                if tid and out
            ]
    return []


async def fetch_tokens_from_clob(client: httpx.AsyncClient, condition_id: str) -> List[dict]:
    if not condition_id:
        return []

    for path in (f"/markets/{condition_id}", f"/market/{condition_id}"):
        try:
            r = await client.get(f"{CLOB_API_URL}{path}", timeout=15)
            if r.status_code >= 400:
                continue
            data = r.json()
            tokens = data.get("tokens")
            if isinstance(tokens, list) and tokens:
                parsed = []
                for t in tokens:
                    token_id = t.get("token_id") or t.get("tokenId")
                    outcome = t.get("outcome")
                    if token_id and outcome:
                        parsed.append({"token_id": token_id, "outcome": outcome})
                if parsed:
                    return parsed
        except Exception:
            continue
    return []
