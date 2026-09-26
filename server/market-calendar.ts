/**
 * NYSE / Nasdaq regular-session calendar, computed from the exchange's rules
 * (no data file to keep updated). All dates are ET wall-clock dates.
 *
 * Full-day closures: New Year's Day, Martin Luther King Jr. Day, Washington's
 * Birthday, Good Friday, Memorial Day, Juneteenth (from 2022), Independence
 * Day, Labor Day, Thanksgiving, Christmas. A holiday on Saturday is observed
 * the Friday before and one on Sunday the Monday after — except New Year's
 * Day on a Saturday, which is not made up on Friday Dec 31.
 *
 * Early closes (13:00 ET): July 3 when it's a weekday and Independence Day is
 * observed on July 4, the day after Thanksgiving, and Christmas Eve when it's
 * a weekday.
 *
 * One-off closures (national days of mourning, weather) can't be derived and
 * aren't modelled.
 */

const OPEN_MINUTES = 9 * 60 + 30;
const CLOSE_MINUTES = 16 * 60;
const EARLY_CLOSE_MINUTES = 13 * 60;

/** yyyy-mm-dd key for a calendar date (month is 1-based). */
function key(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function weekday(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The n-th (1-based) given weekday of a month; n = -1 means the last one. */
function nthWeekday(y: number, m: number, dow: number, n: number): number {
  if (n > 0) {
    const first = weekday(y, m, 1);
    return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = weekday(y, m, lastDay);
  return lastDay - ((last - dow + 7) % 7);
}

/** Western (Gregorian) Easter Sunday — anonymous Gregorian algorithm. */
function easter(y: number): { m: number; d: number } {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

/** Shift a fixed-date holiday off the weekend (Sat → Fri, Sun → Mon). */
function observed(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  if (dow === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  if (dow === 0) dt.setUTCDate(dt.getUTCDate() + 1);
  return key(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

const holidayCache = new Map<number, Set<string>>();

function holidaysFor(y: number): Set<string> {
  const cached = holidayCache.get(y);
  if (cached) return cached;
  const s = new Set<string>();

  // New Year's Day: Sunday → Monday; Saturday → not observed.
  if (weekday(y, 1, 1) !== 6) s.add(observed(y, 1, 1));
  s.add(key(y, 1, nthWeekday(y, 1, 1, 3)));   // MLK Day: 3rd Monday of January
  s.add(key(y, 2, nthWeekday(y, 2, 1, 3)));   // Washington's Birthday: 3rd Monday of February
  const e = easter(y);                        // Good Friday: 2 days before Easter
  const gf = new Date(Date.UTC(y, e.m - 1, e.d - 2));
  s.add(key(gf.getUTCFullYear(), gf.getUTCMonth() + 1, gf.getUTCDate()));
  s.add(key(y, 5, nthWeekday(y, 5, 1, -1)));  // Memorial Day: last Monday of May
  if (y >= 2022) s.add(observed(y, 6, 19));   // Juneteenth
  s.add(observed(y, 7, 4));                   // Independence Day
  s.add(key(y, 9, nthWeekday(y, 9, 1, 1)));   // Labor Day: 1st Monday of September
  s.add(key(y, 11, nthWeekday(y, 11, 4, 4))); // Thanksgiving: 4th Thursday of November
  s.add(observed(y, 12, 25));                 // Christmas

  holidayCache.set(y, s);
  return s;
}

function isEarlyClose(y: number, m: number, d: number): boolean {
  const dow = weekday(y, m, d);
  if (dow === 0 || dow === 6) return false;
  // July 3, when Independence Day itself falls on a weekday and is observed on the 4th.
  if (m === 7 && d === 3 && observed(y, 7, 4) === key(y, 7, 4)) return true;
  // Day after Thanksgiving.
  if (m === 11 && d === nthWeekday(y, 11, 4, 4) + 1) return true;
  // Christmas Eve.
  if (m === 12 && d === 24) return true;
  return false;
}

/** True if the exchange is closed all day on this ET calendar date. */
export function isMarketHoliday(etDate: Date): boolean {
  const y = etDate.getFullYear(), m = etDate.getMonth() + 1, d = etDate.getDate();
  return holidaysFor(y).has(key(y, m, d));
}

/**
 * Whether the US regular session is open at the given ET wall-clock time
 * (a Date whose local fields are ET, as produced by toLocaleString with
 * timeZone "America/New_York").
 */
export function isRegularSessionOpen(etNow: Date): boolean {
  const dow = etNow.getDay();
  if (dow === 0 || dow === 6) return false;
  if (isMarketHoliday(etNow)) return false;
  const y = etNow.getFullYear(), m = etNow.getMonth() + 1, d = etNow.getDate();
  const close = isEarlyClose(y, m, d) ? EARLY_CLOSE_MINUTES : CLOSE_MINUTES;
  const mins = etNow.getHours() * 60 + etNow.getMinutes();
  return mins >= OPEN_MINUTES && mins < close;
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

/** ET wall-clock fields of an instant, read back as if they were UTC. */
function etWallAsUtc(t: number): number {
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** The UTC instant of an ET wall-clock time (handles EST and EDT). */
function etToUtc(y: number, m: number, d: number, minutes: number): number {
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let t = wall + (wall - etWallAsUtc(wall));
  t = wall + (t - etWallAsUtc(t)); // second pass settles DST-change days
  return t;
}

/**
 * Whether the regular session is open at `now`, and when that next changes:
 * today's close while open, otherwise the next trading day's open.
 */
export function nextSessionChange(now: Date = new Date()): { open: boolean; at: Date } {
  const wall = new Date(etWallAsUtc(now.getTime()));
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + i));
    const y = day.getUTCFullYear(), m = day.getUTCMonth() + 1, d = day.getUTCDate();
    const dow = day.getUTCDay();
    if (dow === 0 || dow === 6 || holidaysFor(y).has(key(y, m, d))) continue;
    const open = etToUtc(y, m, d, OPEN_MINUTES);
    const close = etToUtc(y, m, d, isEarlyClose(y, m, d) ? EARLY_CLOSE_MINUTES : CLOSE_MINUTES);
    if (now.getTime() < open) return { open: false, at: new Date(open) };
    if (now.getTime() < close) return { open: true, at: new Date(close) };
  }
  throw new Error("no trading day in the next two weeks");
}
