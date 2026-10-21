/** Shared formatting helpers for the run/trip surfaces. */

export function formatDuration(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)}s` : `${Math.round(seconds / 60)} min`;
}

export function formatDistance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

export function countdownClock(deadlineAt: number, now: number): string {
  const left = Math.max(0, Math.ceil((deadlineAt - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}
