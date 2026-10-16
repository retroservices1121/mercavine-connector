let override: Date | null = null;

export function now(): Date {
  return override ? new Date(override.getTime()) : new Date();
}

export function setNow(date: Date | null): void {
  override = date ? new Date(date.getTime()) : null;
}

export function nowIso(): string {
  return now().toISOString();
}

export function addMinutes(from: Date, minutes: number): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export function addHours(from: Date, hours: number): string {
  return new Date(from.getTime() + hours * 3_600_000).toISOString();
}

export function addDays(from: Date, days: number): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
