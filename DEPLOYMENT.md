# Deployment

Powerhouse Trading Bot is published to Replit as a **Reserved VM**
deployment. Reserved VM is the only target that keeps the engine
ticking 24/7 — Autoscale would spin the process down between requests,
which would pause the auto-trader the moment your browser disconnects.

## Configuration (already set)

The `.replit` file's `[deployment]` section is already wired up:

```
deploymentTarget = "vm"
build            = ["npm", "run", "build"]
run              = ["npm", "run", "start"]
```

- `npm run build` compiles the client (`vite build`) and the server
  bundle (`dist/index.cjs`).
- `npm run start` runs `NODE_ENV=production node dist/index.cjs`.
- SQLite (`data.db`) lives on the VM's local disk and is preserved
  across redeploys.

## Required secrets

The deployment needs all three of these set in the **Publishing →
Secrets** panel (the dev workspace secrets are *not* automatically
copied):

- `ALPACA_KEY_ID`
- `ALPACA_SECRET_KEY`
- `OPERATOR_PASSWORD`

Without `ALPACA_*` the live price feed will fail and the bot will fall
back to pure simulation. Without `OPERATOR_PASSWORD` the operator
login won't accept any password.

## First-time publish

1. From the main repl, open the **Publish** tool.
2. Confirm **Reserved VM** is selected (smallest tier is enough — the
   engine is single-process and SQLite-backed).
3. Set the three secrets listed above.
4. Click **Publish** and wait for the build to finish.
5. Open the deployment URL, log in, and confirm:
   - API feed badge shows `LIVE`
   - `totalTicks` on the dashboard is incrementing (~30/min)
   - Alpaca paper account balance appears in the dual-balance widget

## Uptime check

This is the test that proves the deployment is doing its job:

1. Note `totalTicks` from the dashboard (visible in the Signals tab
   pulse line, e.g. `… · 1234 ticks`).
2. Close the browser tab. Wait 15 minutes.
3. Reopen the deployment URL. `totalTicks` should have advanced by
   roughly `15 × 30 = 450`. If it hasn't, the VM is not running — see
   "Logs" below.

## Redeploying after code changes

1. Merge the change into the main repl.
2. Open the **Publish** tool and click **Publish** again. Replit will
   re-run `npm run build` and roll the VM over to the new bundle.
3. The engine **auto-resumes** on restart: `server/index.ts` checks the
   persisted `engine_state` and re-calls `startAutoTrader()` if it was
   running before the restart. Restored open positions are re-seeded
   into the price simulator so stop-loss / take-profit checks fire on
   the very first post-restart tick.

## Rolling back

Each successful publish becomes a versioned build in the **Publishing →
History** panel. To roll back:

1. Open **Publishing → History**.
2. Find the last known-good build.
3. Click **Promote** (or **Rollback**) on that build.

Rollbacks reuse the existing build artifact, so they take seconds and
do not rebuild from source. `data.db` is *not* rewound — only the code
moves. If a bad release wrote bogus trades, use the in-app **Reset
Portfolio** action after rolling back.

## Logs

Live deployment logs are visible under **Publishing → Logs**. Filter
for `[auto-trader]` to see the tick loop, breaker events, and trade
entries/exits.

## Upgrading the VM tier

Open **Publishing → Settings** and pick a larger Reserved VM tier.
Replit will rebuild and migrate. No code changes are needed — the
engine is single-process and CPU/RAM-bound, not horizontally scaled.

## Known limits

- **SQLite is single-instance.** Reserved VM only runs one process, so
  this is fine. If you ever switch to a multi-instance deployment
  model, migrate `data.db` to a managed Postgres first.
- **No custom domain configured** by default. Use the auto-generated
  `*.replit.app` URL, or wire one up under **Publishing → Domains**.
