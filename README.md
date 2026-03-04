# Polymarket Bot + Monitor

This repo now has two parts:

- The original Python bot in the repo root.
- A live web dashboard in `backend/` and `frontend/`.

## Backend (API + live large trades)

From the repo root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend\requirements.txt

$env:FRONTEND_ORIGIN="http://localhost:5173"
$env:DASH_TOP_N="500"
$env:DASH_MIN_TOP_N="200"
$env:TRADE_ABS_MIN_SIZE="1000"
$env:TRADE_SIZE_MULTIPLIER="6"
$env:TRADE_SIZE_WINDOW="50"

uvicorn backend.main:app --reload --port 8000
```

API endpoints:

- `GET /api/markets` for polled market stats
- `GET /api/health`
- `WS /ws/large-trades` for live large-trade alerts

## Frontend (React)

From the repo root:

```powershell
cd frontend
npm install
$env:VITE_API_BASE="http://localhost:8000"
npm run dev
```

Open `http://localhost:5173`.

## Notes

- The large-trade stream uses the public CLOB market websocket.
- Market polling uses the public Gamma API.
- No API keys are required for the current setup.
