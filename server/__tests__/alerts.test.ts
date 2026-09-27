/**
 * Telegram alerts are actually sent for the engine's trades (only the test
 * message used to be), respect the Settings switches, and escape HTML.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/alerts.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = path.join(os.tmpdir(), `alerts-test-${process.pid}.db`);
for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* none */ } }
process.env.DATA_DB_PATH = TEST_DB;
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "42";

// Capture Telegram calls instead of sending them.
const sent: Array<{ url: string; body: { chat_id: string; text: string } }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  sent.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const at = await import("../auto-trader.js");
const { storage, sqlite } = await import("../storage.js");
const { escapeHtml, notify } = await import("../alerts.js");

beforeEach(() => { sent.length = 0; });
after(() => {
  globalThis.fetch = realFetch;
  at.resetAutoTraderState();
  try { sqlite.close(); } catch { /* noop */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.unlinkSync(TEST_DB + ext); } catch { /* noop */ } }
});

const texts = () => sent.map(s => s.body.text);

test("the engine sends entry and exit alerts to the configured chat", () => {
  at.resetAutoTraderState();
  at.startAutoTrader();
  for (let i = 0; i < 400 && !(texts().some(t => t.includes("Bought")) && texts().some(t => t.includes("Sold"))); i++) at.autoTraderTick();
  at.stopAutoTrader();
  assert.ok(texts().some(t => t.startsWith("<b>Bought ")), "entry alert");
  assert.ok(texts().some(t => t.startsWith("<b>Sold ") && /Trade result [+-]\$/.test(t)), "exit alert with the result");
  assert.ok(sent.every(s => s.url === "https://api.telegram.org/bottest-token/sendMessage" && s.body.chat_id === "42"));
});

test("Settings switches turn alerts off", () => {
  storage.saveSettings({ alertBuySignals: false });
  notify("entry", "Bought X", "d");
  notify("exit", "Sold X", "d");
  assert.deepEqual(texts(), ["<b>Sold X</b>\nd"]);

  sent.length = 0;
  storage.saveSettings({ alertsEnabled: false });
  notify("exit", "Sold X", "d");
  notify("breaker", "Circuit breaker tripped", "d");
  assert.equal(sent.length, 0);
  storage.saveSettings({ alertsEnabled: true, alertBuySignals: true });
});

test("alert text is escaped for Telegram's HTML mode", () => {
  assert.equal(escapeHtml("P&L < 0 > -1"), "P&amp;L &lt; 0 &gt; -1");
  notify("breaker", "Down <3%", "a & b");
  assert.equal(texts()[0], "<b>Down &lt;3%</b>\na &amp; b");
});
