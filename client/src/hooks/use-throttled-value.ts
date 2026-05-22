import { useEffect, useRef, useState } from "react";

/**
 * useThrottledValue
 *
 * Returns a throttled copy of `value` that updates at most once per
 * `intervalMs`. Use this on the leaves of high-frequency feeds so a flood
 * of ticks (e.g. an Alpaca WebSocket stream) never causes more than a few
 * React renders per second per component.
 *
 * Behaviour:
 *  - First value is emitted immediately.
 *  - Subsequent values are coalesced: only the most-recent value within
 *    the interval is shown when the throttle fires.
 *  - When `value` stops changing, the final value is always rendered
 *    (a trailing-edge flush).
 */
export function useThrottledValue<T>(value: T, intervalMs = 250): T {
  const [throttled, setThrottled] = useState<T>(value);
  const lastEmittedAt = useRef<number>(0);
  const pendingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValue = useRef<T>(value);

  useEffect(() => {
    latestValue.current = value;
    const now = Date.now();
    const elapsed = now - lastEmittedAt.current;

    if (elapsed >= intervalMs) {
      lastEmittedAt.current = now;
      setThrottled(value);
      return;
    }

    if (pendingTimeout.current) return; // already scheduled; will pick up latestValue

    pendingTimeout.current = setTimeout(() => {
      pendingTimeout.current = null;
      lastEmittedAt.current = Date.now();
      setThrottled(latestValue.current);
    }, intervalMs - elapsed);
  }, [value, intervalMs]);

  useEffect(() => {
    return () => {
      if (pendingTimeout.current) {
        clearTimeout(pendingTimeout.current);
        pendingTimeout.current = null;
      }
    };
  }, []);

  return throttled;
}
