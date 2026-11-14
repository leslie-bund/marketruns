export function money(kobo: number | null | undefined): string {
  if (kobo === null || kobo === undefined) return "—";
  return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 2 }).format(kobo / 100);
}

export function number(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : new Intl.NumberFormat("en-NG").format(value);
}

export function dateTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-NG", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function relativeTime(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.round((time - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, divisor] of ranges) {
    if (Math.abs(seconds) >= divisor) return formatter.format(Math.round(seconds / divisor), unit);
  }
  return formatter.format(seconds, "second");
}

export function bps(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${(value / 100).toFixed(2)}%`;
}

export function duration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined) return "—";
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function distance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return "—";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export function shortId(value: string | null | undefined, length = 22): string {
  if (!value) return "—";
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replaceAll("_", " ").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function captureUrl(ref: string): string | null {
  const prefix = "r2://archive/";
  return ref.startsWith(prefix) ? `/ops/api/captures/${encodeURIComponent(ref.slice(prefix.length))}` : null;
}

export function includesQuery(values: unknown[], query: string): boolean {
  if (!query.trim()) return true;
  const needle = query.trim().toLowerCase();
  return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
}

export function addQuery(path: string, params: Record<string, string | number | undefined>): string {
  const [pathname, existing = ""] = path.split("?");
  const query = new URLSearchParams(existing);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  const result = query.toString();
  return `${pathname}${result ? `?${result}` : ""}`;
}
