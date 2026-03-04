import json
import os
from datetime import datetime, timezone
from typing import List

import httpx

GAMMA_API_URL = "https://gamma-api.polymarket.com/markets"
CLOB_API_URL = "https://clob.polymarket.com"


def _resolve_top_n() -> int:
    requested = int(os.getenv("DASH_TOP_N", "500"))
    min_allowed = int(os.getenv("DASH_MIN_TOP_N", "200"))
    return max(1, max(requested, min_allowed))


TOP_N = _resolve_top_n()


def _parse_iso_dt(value: str):
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _is_open_market(market: dict, now: datetime) -> bool:
    # Respect explicit lifecycle flags first.
    if market.get("closed") is True:
        return False
    if market.get("active") is False:
        return False
    if market.get("archived") is True:
        return False

    # If end date is known and in the past, treat as not open.
    end_dt = _parse_iso_dt(market.get("endDate"))
    if end_dt and end_dt <= now:
        return False
    return True


async def fetch_top_markets(client: httpx.AsyncClient) -> List[dict]:
    now = datetime.now(timezone.utc)
    collected: List[dict] = []
    seen_ids = set()
    page_size = min(100, max(20, TOP_N))
    offset = 0

    # Gamma is often paginated; keep fetching until we have enough.
    while len(collected) < TOP_N:
        r = await client.get(
            GAMMA_API_URL,
            params={
                "active": "true",
                "closed": "false",
                "archived": "false",
                "include_tag": "true",
                "limit": str(page_size),
                "offset": str(offset),
            },
            timeout=15,
        )
        page = r.json()
        if not isinstance(page, list) or not page:
            break

        added_this_page = 0
        for m in page:
            if not isinstance(m, dict):
                continue
            market_id = m.get("id") or m.get("conditionId") or m.get("condition_id")
            if market_id and market_id in seen_ids:
                continue
            if _is_open_market(m, now):
                collected.append(m)
                if market_id:
                    seen_ids.add(market_id)
                added_this_page += 1
                if len(collected) >= TOP_N:
                    break

        # Stop if we reached the end or got no usable additions.
        if len(page) < page_size or added_this_page == 0:
            break
        offset += page_size

    markets = collected
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
