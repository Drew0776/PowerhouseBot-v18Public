# Threat Model

## Project Overview

This project is a full-stack trading dashboard and paper-trading simulator built with an Express 5 backend, a React + Vite frontend, and a local SQLite database accessed through Drizzle ORM. The server exposes public HTTP API routes for portfolio views, scanner data, bot control, settings, trade execution, and third-party integrations such as Alpaca market data and Telegram alerts. There is currently no implemented authentication layer in the production server code.

## Assets

- **Portfolio state and trading history** — trade records, open positions, equity curve, bot state, and simulated cash balances. Unauthorized modification changes application behavior and corrupts portfolio history.
- **Operational controls** — start/stop/reset actions for the auto-trader and grid bots, plus settings that influence strategy behavior and alerts. Unauthorized access gives outsiders direct control over the app.
- **Third-party integration value** — Alpaca API credentials are server-side secrets, and the connected paper account status, buying power, and quote-refresh capacity are operationally sensitive. Telegram integration can be abused to send unwanted messages.
- **Application secrets** — environment variables such as `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. They must remain server-only and must not be inferable through public endpoints.
- **Service availability** — background trading loops, backtests, quote refreshes, and notification endpoints can consume CPU, network calls, and external service quotas.

## Trust Boundaries

- **Browser to Express API** — all client requests cross from an untrusted browser to trusted server code. Every route must treat request data as attacker-controlled.
- **Express API to SQLite** — the server persists application state directly to `data.db`. Unsafe server actions can permanently alter trade history, settings, or engine state.
- **Express API to external services** — the backend calls Alpaca and Telegram using server-held secrets. Public endpoints that trigger these calls can convert internet traffic into third-party abuse.
- **Public to privileged operations** — scanner reads are low sensitivity, but bot control, resets, settings changes, and integration diagnostics are privileged operations that require a server-enforced boundary.
- **Production to dev-only repository content** — `.agents/`, `.local/skills/`, and other agent/tooling assets may contain insecure examples, but they are not production application paths unless explicitly executed by shipped server code.

## Scan Anchors

- Production server entry: `server/index.ts`
- Primary API surface: `server/routes.ts`
- Highest-risk code areas: trading/bot control routes, portfolio reset, settings mutation, Alpaca/Telegram integration endpoints, and background engine state in `server/auto-trader.ts`, `server/grid-engine.ts`, `server/alpaca.ts`
- Public surfaces: all current `/api/*` routes in `server/routes.ts`
- Authenticated/admin surfaces: none implemented today; any route that mutates state or exposes integration state should be treated as missing a privileged boundary
- Usually ignore as dev-only: `.agents/`, `.local/skills/`, skill helper scripts, and build-time agent assets unless production reachability is demonstrated

## Threat Categories

### Spoofing

The application currently has no server-side identity model, so any internet user can appear equivalent to an authorized operator when calling management routes. If the app is deployed publicly, privileged API operations must require a valid authenticated session or other strong operator credential before they are executed.

### Tampering

The backend allows direct creation and closure of trades, settings changes, portfolio resets, and bot lifecycle changes through HTTP routes. The system must guarantee that only authorized operators can trigger state-changing actions and that client input cannot directly rewrite portfolio or engine state outside intended controls.

### Information Disclosure

Operational data such as paper-account status, buying power, cash levels, trade history, and internal bot state is available through API responses. The application must ensure that sensitive operational and account data is only returned to authorized users and that integration secrets never leak through responses, logs, or error messages.

### Denial of Service

Public endpoints can trigger background work, external API refreshes, simulation ticks, and backtests. The system must prevent unauthenticated or untrusted users from consuming server resources or external service quotas through repeated management calls.

### Elevation of Privilege

There is no implemented separation between public read-only access and privileged operator functions. The system must enforce a server-side authorization boundary so that read-only viewers cannot gain bot-control, reset, settings, or integration-triggering capabilities simply by calling documented API routes directly.