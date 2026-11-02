const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

export function paint(
  color: keyof typeof ANSI,
  text: string | number,
): string {
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export const bold = (text: string | number) => paint("bold", text);
export const dim = (text: string | number) => paint("dim", text);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "n/a";
  const sign = bytes < 0 ? "-" : "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = unit === 0 ? 0 : 1;
  return `${sign}${value.toFixed(precision)} ${units[unit]}`;
}

export function formatBytesDelta(bytes: number): string {
  if (bytes === 0) return "0 B";
  const prefix = bytes > 0 ? "+" : "-";
  return `${prefix}${formatBytes(Math.abs(bytes))}`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatSigned(value: number): string {
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "n/a";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/**
 * Tiny table renderer. Values are plain strings so ANSI colors do not break
 * column widths (color is applied to whole rows by the caller when needed).
 */
export function renderTable(
  headers: string[],
  rows: Array<Array<string | number>>,
): string {
  const widths = headers.map((header, index) =>
    Math.max(
      header.length,
      ...rows.map((row) => String(row[index] ?? "").length),
    ),
  );

  const line = (cells: Array<string | number>) =>
    cells
      .map((cell, index) => String(cell ?? "").padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();

  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [line(headers), separator, ...rows.map(line)].join("\n");
}
