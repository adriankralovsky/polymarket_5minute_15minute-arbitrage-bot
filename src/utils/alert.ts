/**
 * Discord webhook alerting utility.
 * Fires a critical-halt notification when the bot stops due to an unwind failure.
 * Set DISCORD_WEBHOOK_URL in .env to enable. Safe to omit — alerts are best-effort.
 */

import { logWarn, logDebug } from "./logger";

/**
 * Send a critical alert to Discord.
 * Fire-and-forget: never throws, never blocks the caller.
 */
export async function sendCriticalAlert(message: string): Promise<void> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    logDebug("DISCORD_WEBHOOK_URL not set — skipping alert");
    return;
  }

  try {
    const payload = {
      username: "BTC Arb Bot",
      embeds: [
        {
          title: "🚨 CRITICAL — Bot halted",
          description: message.substring(0, 4096),
          color: 0xff0000,
          timestamp: new Date().toISOString(),
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logWarn(`Discord alert failed: HTTP ${response.status}`);
    } else {
      logDebug("Discord alert sent");
    }
  } catch (error) {
    // Never propagate — alerting must not interfere with halt logic
    logWarn(`Discord alert error (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
  }
}
