/**
 * Third-audit fixes to the engine's bookkeeping:
 *   - its state is saved to engine_state (it wasn't in development: the code
 *     used require() in an ESM package and swallowed the error);
 *   - a position closed outside the engine is dropped, not "exited" later
 *     with P&L for a sale that never happened.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/engine-state.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `engine-state-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;

const at = await import("../auto-trader.js");
const { storage, sqlite, getEngineStateJson, getStockByTicker } = await import("../storage.js");

after(() => {
  at.resetAutoTraderState();
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

test("engine state is saved, so a restart can resume it", () => {
  at.resetAutoTraderState();
  assert.equal(getEngineStateJson(), null);
  at.startAutoTrader();
  for (let i = 0; i < 5; i++) at.autoTraderTick();
  const saved = JSON.parse(getEngineStateJson()!);
  assert.equal(saved.isRunning, true);
  assert.equal(saved.totalTicks, 5);
  at.stopAutoTrader();
  assert.equal(JSON.parse(getEngineStateJson()!).isRunning, false);
});

test("a position closed outside the engine is dropped without booking P&L", () => {
  at.resetAutoTraderState();
  at.startAutoTrader();
  for (let i = 0; i < 200 && at.getAutoTraderState().openPositions.length === 0; i++) at.autoTraderTick();
  const pos = at.getAutoTraderState().openPositions[0];
  assert.ok(pos, "the engine opened a position");

  // Closed from the Trade Log, as POST /api/trades/:id/close does.
  storage.closeTrade(pos.tradeId, getStockByTicker(pos.ticker)!.price);
  at.autoTraderTick();

  const s = at.getAutoTraderState();
  assert.ok(!s.openPositions.some(p => p.tradeId === pos.tradeId), "no longer managed");
  assert.ok(s.log.some(l => l.includes(`${pos.ticker} was closed outside the engine`)));
  assert.ok(!s.log.some(l => l.includes("EXIT") && l.includes(`| ${pos.ticker} |`)), "no phantom exit booked");
  at.stopAutoTrader();
});

test("the dashboards' live view grades instruments exactly as the engine's scanner does", () => {
  at.resetAutoTraderState();
  at.startAutoTrader();
  for (let i = 0; i < 40; i++) at.autoTraderTick();
  const view = at.liveSignalView();
  const sigs = at.scanForBreakouts({ advance: false });
  assert.ok(sigs.length > 0, "scanner has signals once warmed up");
  for (const s of sigs) {
    const v = view.get(s.ticker)!;
    assert.equal(v.grade, s.grade, `${s.ticker} grade`);
    assert.equal(v.rank, s.rank, `${s.ticker} rank`);
  }
  // Nothing is scored before the engine has history.
  at.resetAutoTraderState();
  assert.ok([...at.liveSignalView().values()].every(v => v.score === null));
  at.stopAutoTrader();
});
