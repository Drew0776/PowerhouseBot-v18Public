/**
 * Telegram alerts. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable
 * (token from https://t.me/BotFather, chat id from https://t.me/userinfobot).
 *
 * The auto-trader sends an alert when it opens a position, closes one, trips
 * the daily-loss circuit breaker, and at the start of each ET trading day
 * with the previous day's P&L. Settings → Notifications turns them off:
 * "Enable alerts" for all of them, "Entry alerts" and "Exit alerts" for those
 * kinds. (Before this module only the test message was ever sent.)
 */

import { storage } from "./storage";

const TIMEOUT_MS = 10_000;

function configured(): { token: string; chatId: string } | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
}

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Send an HTML-formatted message. Resolves true if Telegram accepted it. */
export async function sendTelegramAlert(html: string): Promise<boolean> {
  const c = configured();
  if (!c) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: c.chatId, text: html, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // alerts never break trading
  }
}

export type AlertKind = "entry" | "exit" | "breaker" | "daily";

/**
 * Queue an alert of `kind` if Telegram is configured and the operator's
 * settings allow it. `title` is bold; `detail` is plain text. Fire and forget.
 */
export function notify(kind: AlertKind, title: string, detail: string): void {
  if (!configured()) return;
  const s = storage.getSettings();
  if (!s.alertsEnabled) return;
  if (kind === "entry" && !s.alertBuySignals) return;
  if (kind === "exit" && !s.alertSellSignals) return;
  void sendTelegramAlert(`<b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}`);
}
