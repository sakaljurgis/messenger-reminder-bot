import { describe, expect, it } from 'vitest';
import {
  formatInZone,
  formatRelative,
  parseWallClock,
  promptNow,
  wallClockInZone,
  zonedWallClockToUtc,
} from './time.js';

const VILNIUS = 'Europe/Vilnius';

describe('wallClockInZone', () => {
  it('shows Vilnius summer time (UTC+3)', () => {
    const w = wallClockInZone(new Date('2026-07-15T08:00:00Z'), VILNIUS);
    expect(w).toEqual({ year: 2026, month: 7, day: 15, hour: 11, minute: 0 });
  });

  it('shows Vilnius winter time (UTC+2)', () => {
    const w = wallClockInZone(new Date('2026-01-15T08:00:00Z'), VILNIUS);
    expect(w).toEqual({ year: 2026, month: 1, day: 15, hour: 10, minute: 0 });
  });

  it('crosses the date line relative to UTC when needed', () => {
    const w = wallClockInZone(new Date('2026-07-15T23:30:00Z'), VILNIUS);
    expect(w).toEqual({ year: 2026, month: 7, day: 16, hour: 2, minute: 30 });
  });
});

describe('zonedWallClockToUtc', () => {
  it('converts Vilnius summer wall clock to UTC-3h', () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 7, day: 16, hour: 9, minute: 0 }, VILNIUS);
    expect(d.toISOString()).toBe('2026-07-16T06:00:00.000Z');
  });

  it('converts Vilnius winter wall clock to UTC-2h', () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, VILNIUS);
    expect(d.toISOString()).toBe('2026-01-15T07:00:00.000Z');
  });

  it('is identity for UTC', () => {
    const d = zonedWallClockToUtc({ year: 2026, month: 3, day: 1, hour: 12, minute: 34 }, 'UTC');
    expect(d.toISOString()).toBe('2026-03-01T12:34:00.000Z');
  });

  it('handles a fixed-offset zone without DST (Tokyo, UTC+9)', () => {
    const d = zonedWallClockToUtc(
      { year: 2026, month: 12, day: 25, hour: 8, minute: 0 },
      'Asia/Tokyo',
    );
    expect(d.toISOString()).toBe('2026-12-24T23:00:00.000Z');
  });

  it('resolves a nonexistent spring-forward time to a nearby instant', () => {
    // Vilnius jumps 03:00 -> 04:00 on 2026-03-29; 03:30 never happens.
    const wall = { year: 2026, month: 3, day: 29, hour: 3, minute: 30 };
    const d = zonedWallClockToUtc(wall, VILNIUS);
    // Whatever it resolves to must be within an hour of both candidate offsets.
    const eet = Date.UTC(2026, 2, 29, 1, 30); // 03:30 EET (+2)
    const eest = Date.UTC(2026, 2, 29, 0, 30); // 03:30 EEST (+3)
    expect(Math.min(Math.abs(d.getTime() - eet), Math.abs(d.getTime() - eest))).toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
  });

  it('resolves an ambiguous fall-back time to one of the two real instants', () => {
    // Vilnius falls back 04:00 -> 03:00 on 2026-10-25; 03:30 happens twice.
    const wall = { year: 2026, month: 10, day: 25, hour: 3, minute: 30 };
    const d = zonedWallClockToUtc(wall, VILNIUS);
    expect(wallClockInZone(d, VILNIUS)).toEqual({
      year: 2026,
      month: 10,
      day: 25,
      hour: 3,
      minute: 30,
    });
  });
});

describe('parseWallClock', () => {
  it('parses the canonical LLM shape', () => {
    expect(parseWallClock('2026-07-16T09:00')).toEqual({
      year: 2026,
      month: 7,
      day: 16,
      hour: 9,
      minute: 0,
    });
  });

  it('tolerates a space separator and trailing seconds', () => {
    expect(parseWallClock('2026-07-16 09:05:30')).toEqual({
      year: 2026,
      month: 7,
      day: 16,
      hour: 9,
      minute: 5,
    });
  });

  it('tolerates a decorative trailing Z (observed live) but keeps it local', () => {
    expect(parseWallClock('2026-07-16T14:30:00Z')).toEqual({
      year: 2026,
      month: 7,
      day: 16,
      hour: 14,
      minute: 30,
    });
  });

  it.each([
    '',
    'tomorrow at nine',
    '2026-02-30T10:00', // no Feb 30
    '2026-07-16T24:00',
    '2026-07-16T09:60',
    '2026-13-01T09:00',
    '26-07-16T09:00',
    '2026-07-16', // date without time
  ])('rejects %j', (s) => {
    expect(parseWallClock(s)).toBeNull();
  });
});

describe('promptNow', () => {
  it('renders weekday + local wall clock in the zone', () => {
    expect(promptNow(new Date('2026-07-15T08:05:00Z'), VILNIUS)).toBe('Wednesday 2026-07-15 11:05');
  });

  it('uses the zone for the weekday, not UTC', () => {
    // 23:30Z Wednesday is already Thursday in Vilnius.
    expect(promptNow(new Date('2026-07-15T23:30:00Z'), VILNIUS)).toBe('Thursday 2026-07-16 02:30');
  });
});

describe('formatInZone', () => {
  const now = new Date('2026-07-15T08:00:00Z');

  it('omits the year when current', () => {
    expect(formatInZone(new Date('2026-07-16T06:00:00Z'), VILNIUS, now)).toBe('Thu, Jul 16 09:00');
  });

  it('appends the year when different', () => {
    expect(formatInZone(new Date('2027-01-02T07:00:00Z'), VILNIUS, now)).toBe(
      'Sat, Jan 2 2027 09:00',
    );
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-07-15T08:00:00Z');
  const at = (iso: string) => formatRelative(new Date(iso), now);

  it.each([
    ['2026-07-15T08:00:30Z', 'in under a minute'],
    ['2026-07-15T08:45:00Z', 'in 45 min'],
    ['2026-07-15T10:05:00Z', 'in 2 h 5 min'],
    ['2026-07-15T10:00:00Z', 'in 2 h'],
    ['2026-07-18T12:00:00Z', 'in 3 d 4 h'],
    ['2026-07-18T08:00:00Z', 'in 3 d'],
  ])('%s -> %s', (iso, expected) => {
    expect(at(iso)).toBe(expected);
  });
});
