import pytest

from backend import main


class DummyTask:
    def cancel(self):
        return None


@pytest.mark.asyncio
async def test_connect_db_returns_none_when_required_env_missing(monkeypatch):
    import db

    for key in db.REQUIRED_ENV_VARS:
        monkeypatch.delenv(key, raising=False)

    pool = await db.connect_db()

    assert pool is None


@pytest.mark.asyncio
async def test_on_startup_initializes_db_pool(monkeypatch):
    called = {"connect": False, "init": False, "cache": False, "tasks": 0}

    async def fake_connect_db():
        called["connect"] = True
        return "pool"

    async def fake_init_db(pool):
        called["init"] = True
        assert pool == "pool"

    async def fake_cache_update():
        called["cache"] = True

    def fake_create_task(coro):
        called["tasks"] += 1
        coro.close()
        return DummyTask()

    monkeypatch.setattr(main, "db_pool", None)
    monkeypatch.setattr(main, "connect_db", fake_connect_db)
    monkeypatch.setattr(main, "init_db", fake_init_db)
    monkeypatch.setattr(main.cache, "update", fake_cache_update)
    monkeypatch.setattr(main.asyncio, "create_task", fake_create_task)

    await main.on_startup()

    assert called == {"connect": True, "init": True, "cache": True, "tasks": 3}
    assert main.db_pool == "pool"
