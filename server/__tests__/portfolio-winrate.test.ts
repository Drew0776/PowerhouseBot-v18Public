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
