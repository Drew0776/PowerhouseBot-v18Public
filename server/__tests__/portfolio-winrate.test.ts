/**
 * The dashboard win rate counts positions, not trade rows: a T1 partial exit
 * is stored as its own closed row, and it used to count as an extra win.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/portfolio-winrate.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `portfolio-winrate-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;

const { storage, sqlite } = await import("../storage.js");

after(() => {
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

const open = (ticker: string, price: number, shares: number) => storage.createTrade({
  ticker, action: "buy", shares, price, total: price * shares,
  stopLoss: price * 0.98, takeProfit: price * 1.02, openedAt: new Date().toISOString(),
});

test("a T1 partial and its losing remainder count as one losing trade", () => {
  sqlite.prepare("DELETE FROM trades").run();
  const t = open("AAA", 10, 10);
  storage.partialCloseTrade(t.id, 5, 10.2);           // +$1.00 partial
  assert.equal(storage.getPortfolio().winRate, 0, "a position still open is not counted yet");
  storage.closeTrade(t.id, 9.6);                      // −$2.00 on the rest
  assert.equal(storage.getPortfolio().winRate, 0);    // net −$1.00 → one loss (was 50%)
});

test("win rate is wins over closed positions", () => {
  sqlite.prepare("DELETE FROM trades").run();
  const a = open("AAA", 10, 10);
  storage.partialCloseTrade(a.id, 5, 10.2);
  storage.closeTrade(a.id, 10.4);                     // winner with a partial
  const b = open("BBB", 20, 5);
  storage.closeTrade(b.id, 19);                       // loser
  const c = open("CCC", 5, 10);
  storage.closeTrade(c.id, 5.5);                      // winner
  assert.equal(storage.getPortfolio().winRate, 66.67);
});

test("portfolio reads stay fast and current with a large trade history", () => {
  sqlite.prepare("DELETE FROM trades").run();
  const ins = sqlite.prepare(`INSERT INTO trades (ticker, action, shares, price, total, status, pnl, opened_at, closed_at)
    VALUES (?, 'buy', 1, ?, ?, ?, ?, ?, ?)`);
  sqlite.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      const open = i % 20 === 0;
      ins.run("T" + (i % 150), 10 + (i % 97), 10, open ? "open" : "closed", open ? null : (i % 3) - 1,
        new Date(1e12 + i * 1000).toISOString(), open ? null : new Date().toISOString());
    }
  })();
  // This took ~1 s per read before the position index and history cache.
  const t0 = performance.now();
  const first = storage.getPortfolio();
  for (let k = 0; k < 9; k++) storage.getPortfolio();
  const perRead = (performance.now() - t0) / 10;
  assert.ok(perRead < 100, `${perRead.toFixed(1)} ms per read`);

  // The cache must notice new trades.
  const t = open("ZZZ", 10, 1);
  storage.closeTrade(t.id, 12);
  const after = storage.getPortfolio();
  assert.equal(Math.round((after.cash - first.cash) * 100) / 100, 2, "bought at $10, sold at $12");
});
