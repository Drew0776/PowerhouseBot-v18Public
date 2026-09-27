/**
 * Checks server/market-calendar.ts against the NYSE's published holiday and
 * early-close schedules.
 *
 * Run from the project root with:   npx tsx --test server/__tests__/market-calendar.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { isMarketHoliday, isRegularSessionOpen } from "../market-calendar.js";

/** ET wall-clock date (month 1-based). */
const et = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);

// Full-day closures as published by NYSE (one-off closures such as the
// 2025-01-09 national day of mourning are not rule-based and are excluded).
const PUBLISHED: Record<number, string[]> = {
  2025: ["01-01", "01-20", "02-17", "04-18", "05-26", "06-19", "07-04", "09-01", "11-27", "12-25"],
  2026: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
  2027: ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"],
};

test("full-day holidays match the published NYSE schedule for 2025–2027", () => {
  for (const [yStr, dates] of Object.entries(PUBLISHED)) {
    const y = Number(yStr);
    const expected = new Set(dates);
    // Every weekday of the year: holiday iff it's on the published list.
    for (let d = new Date(y, 0, 1); d.getFullYear() === y; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const k = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      assert.equal(isMarketHoliday(new Date(d)), expected.has(k), `${y}-${k}`);
    }
  }
});

test("Saturday New Year's Day is not made up on the Friday before", () => {
  // 2022-01-01 was a Saturday: NYSE stayed open on Friday 2021-12-31.
  assert.equal(isMarketHoliday(et(2021, 12, 31)), false);
  assert.equal(isRegularSessionOpen(et(2021, 12, 31, 10)), true);
});

test("Sunday Juneteenth is observed on Monday (first year, 2022)", () => {
  assert.equal(isMarketHoliday(et(2022, 6, 20)), true);
  assert.equal(isMarketHoliday(et(2021, 6, 18)), false, "no Juneteenth closure before 2022");
});

test("early closes end the session at 13:00 ET", () => {
  for (const [y, m, d] of [[2025, 7, 3], [2025, 11, 28], [2025, 12, 24], [2026, 11, 27], [2026, 12, 24]]) {
    assert.equal(isRegularSessionOpen(et(y, m, d, 12, 59)), true, `${y}-${m}-${d} 12:59 open`);
    assert.equal(isRegularSessionOpen(et(y, m, d, 13, 0)), false, `${y}-${m}-${d} 13:00 closed`);
  }
  // 2026-07-04 is a Saturday, so the holiday moves to Friday 07-03 and
  // Thursday 07-02 is a normal full day.
  assert.equal(isRegularSessionOpen(et(2026, 7, 2, 15, 30)), true);
});

test("regular hours on an ordinary trading day", () => {
  assert.equal(isRegularSessionOpen(et(2026, 9, 28, 9, 29)), false);
  assert.equal(isRegularSessionOpen(et(2026, 9, 28, 9, 30)), true);
  assert.equal(isRegularSessionOpen(et(2026, 9, 28, 15, 59)), true);
  assert.equal(isRegularSessionOpen(et(2026, 9, 28, 16, 0)), false);
  assert.equal(isRegularSessionOpen(et(2026, 9, 26, 12)), false, "Saturday");
  assert.equal(isRegularSessionOpen(et(2026, 11, 26, 12)), false, "Thanksgiving");
});
