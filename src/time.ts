/**
 * All date/timezone handling, dependency-free via Intl.
 *
 * The messenger API speaks UTC ISO instants; the human (and the LLM prompt)
 * speak wall-clock time in USER_TIMEZONE (e.g. Europe/Vilnius, UTC+2/+3 with
 * DST). This module is the only place the two meet: the LLM's output never
 * goes near `new Date(string)` (its parsing rules for zoneless strings are a
 * trap — sometimes UTC, sometimes local), and the process TZ is irrelevant.
 */

/** True iff Intl can resolve `zone` as an IANA timezone name. */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A local wall-clock reading, 1-based month, 24h clock. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** What wall clock does UTC instant `date` show in `timeZone`? */
export function wallClockInZone(date: Date, timeZone: string): WallClock {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function asUtcMs(w: WallClock): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
}

/**
 * Interpret a wall-clock reading as a moment in `timeZone` and return the UTC
 * instant. Standard iterative technique: guess "wall clock == UTC", then
 * correct by the offset the zone actually shows at that guess; two passes
 * absorb DST-transition edges. Local times that don't exist (spring-forward
 * gap) or exist twice (fall-back) resolve to a nearby valid instant — an
 * acceptable answer for reminders.
 */
export function zonedWallClockToUtc(wall: WallClock, timeZone: string): Date {
  const want = asUtcMs(wall);
  let ts = want;
  for (let i = 0; i < 2; i++) {
    ts += want - asUtcMs(wallClockInZone(new Date(ts), timeZone));
  }
  return new Date(ts);
}

/**
 * Parse the LLM's `when_local` field ("YYYY-MM-DDTHH:MM"; a space separator,
 * trailing seconds, a decorative trailing "Z" and 1-digit month/day/hour are
 * tolerated — small models drop leading zeros and cargo-cult the Z while
 * clearly meaning local time). Strict full-match otherwise + range/roundtrip
 * validation — never `new Date(string)`. Returns null on anything dubious.
 */
export function parseWallClock(s: string): WallClock | null {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::\d{2})?Z?$/.exec(s.trim());
  if (!m) return null;
  const wall: WallClock = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
  };
  if (wall.hour > 23 || wall.minute > 59) return null;
  // Round-trip through Date.UTC to reject Feb 30 etc. (UTC has no DST, so the
  // calendar check is exact).
  const d = new Date(asUtcMs(wall));
  if (
    d.getUTCFullYear() !== wall.year ||
    d.getUTCMonth() !== wall.month - 1 ||
    d.getUTCDate() !== wall.day
  ) {
    return null;
  }
  return wall;
}

/**
 * Same wall-clock time `days` later on the LOCAL calendar. Used for the
 * "user said 8:00 but 8:00 already passed → they meant tomorrow" bump.
 * Deliberately calendar arithmetic on the wall clock, not +86400000 ms on the
 * instant — the latter shifts the wall time by an hour across a DST edge.
 */
export function bumpWallClockDays(wall: WallClock, days: number): WallClock {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The "now" line for the LLM prompt: `Tuesday 2026-07-15 11:42`. Weekday is
 * essential — "tomorrow" / "on Friday" are unresolvable without it.
 */
export function promptNow(now: Date, timeZone: string): string {
  const w = wallClockInZone(now, timeZone);
  // Weekday must come from Intl too (the zone's date can differ from UTC's).
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(now);
  return `${weekday} ${w.year}-${pad(w.month)}-${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** `2026-07-16T09:00` for a wall clock — the exact shape `when_local` uses. */
export function wallClockIso(w: WallClock): string {
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/**
 * A 7-day date lookup for the LLM prompt: small models fail at calendar
 * ARITHMETIC but are fine at table LOOKUP, so "next Friday" becomes a copy
 * job. (Adding whole days to the instant can wobble an hour across DST, but
 * only the resulting local DATE is used, so it would take a midnight-adjacent
 * DST edge to matter — Vilnius transitions at 03:00.)
 */
export function dayLookup(now: Date, timeZone: string): string {
  const entries: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const w = wallClockInZone(d, timeZone);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(d);
    const tag = i === 0 ? ' (today)' : i === 1 ? ' (tomorrow/rytoj)' : '';
    entries.push(`${weekday}${tag}=${w.year}-${pad(w.month)}-${pad(w.day)}`);
  }
  return entries.join(', ');
}

/**
 * Human-facing timestamp in the user's zone: `Wed, Jul 16 09:00`, with the
 * year appended only when it differs from the current one (`Sat, Jan 2 2027
 * 09:00`).
 */
export function formatInZone(date: Date, timeZone: string, now: Date): string {
  const w = wallClockInZone(date, timeZone);
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const year = w.year === wallClockInZone(now, timeZone).year ? '' : ` ${w.year}`;
  return `${weekday}, ${MONTHS[w.month - 1]} ${w.day}${year} ${pad(w.hour)}:${pad(w.minute)}`;
}

/** Compact relative delta for confirmations: "in 45 min", "in 2 h 5 min", "in 3 d 4 h". */
export function formatRelative(target: Date, now: Date): string {
  const totalMin = Math.floor((target.getTime() - now.getTime()) / 60_000);
  if (totalMin < 1) return 'in under a minute';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  if (days > 0) return hours > 0 ? `in ${days} d ${hours} h` : `in ${days} d`;
  if (hours > 0) return mins > 0 ? `in ${hours} h ${mins} min` : `in ${hours} h`;
  return `in ${mins} min`;
}
