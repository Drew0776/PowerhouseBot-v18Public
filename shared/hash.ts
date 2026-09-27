/**
 * FNV-1a 32-bit hash: a stable, well-spread seed per ticker. The simulators
 * used to seed from the plain sum of character codes, which collides for any
 * tickers with the same letters or sums (RIOT, WULF and KULR all sum to 318),
 * so 135 of the 181 instruments moved in lockstep with at least one other.
 */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
