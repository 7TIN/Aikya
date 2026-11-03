const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Parse a short duration such as `30s`, `30m`, `24h`, or `7d`.
 * Kept intentionally small: branch retention only needs second/day granularity.
 */
export function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}". Use a number plus s, m, h, or d (for example 30s, 30m, 24h, 7d).`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Duration "${value}" must be greater than zero.`);
  }

  const unitMs =
    unit === "s" ? SECOND : unit === "m" ? MINUTE : unit === "h" ? HOUR : DAY;
  return amount * unitMs;
}

export function formatDuration(ms: number): string {
  const value = Math.max(0, ms);
  if (value >= DAY) return `${(value / DAY).toFixed(1)}d`;
  if (value >= HOUR) return `${(value / HOUR).toFixed(1)}h`;
  if (value >= MINUTE) return `${Math.max(1, Math.round(value / MINUTE))}m`;
  return `${Math.max(1, Math.round(value / SECOND))}s`;
}
