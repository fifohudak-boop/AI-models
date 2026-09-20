const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function weekdayLabels(): string[] {
  return WEEKDAY_LABELS;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toISODate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function formatMonthYear(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export function formatDayHeading(date: Date): string {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

export function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

export interface MonthDay {
  date: Date;
  iso: string;
}

/**
 * The real days of one month only (no leading/trailing days borrowed from
 * neighboring months) — `null` placeholders pad the front so day 1 lands in
 * its correct weekday column.
 */
export function getCurrentMonthDays(monthAnchor: Date): Array<MonthDay | null> {
  const year = monthAnchor.getFullYear();
  const month = monthAnchor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const leadingBlanks = firstOfMonth.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: Array<MonthDay | null> = Array.from({ length: leadingBlanks }, () => null);
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day);
    cells.push({ date, iso: toISODate(date) });
  }
  return cells;
}

/** Parses "9:00-10:00" / "09:00–10:00" / "9am-10am" style ranges into minutes since midnight. Returns null if unparseable. */
export function parseTimeRange(time: string): { start: number; end: number } | null {
  const parts = time.split(/[-–—]/).map((p) => p.trim());
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start === null || end === null) return null;
  return { start, end };
}

function parseClock(value: string): number | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(value);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}
