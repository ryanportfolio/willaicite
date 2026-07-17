import { describe, it, expect } from 'vitest';
import { parseDateUTC } from '../src/dates.js';

describe('parseDateUTC', () => {
  it('treats a timezone-less datetime as UTC wall-clock (machine-timezone independent)', () => {
    expect(parseDateUTC('2026-06-20T09:00:00')!.getTime()).toBe(parseDateUTC('2026-06-20T09:00:00Z')!.getTime());
  });

  it('leaves explicitly-zoned and ISO date-only forms untouched', () => {
    expect(parseDateUTC('2026-06-20')!.toISOString()).toBe('2026-06-20T00:00:00.000Z');
    expect(parseDateUTC('Mon, 29 Jun 2026 10:00:00 GMT')!.toISOString()).toBe('2026-06-29T10:00:00.000Z');
    expect(parseDateUTC('2026-06-20T09:00:00+02:00')!.toISOString()).toBe('2026-06-20T07:00:00.000Z');
  });

  it('parses month-name dates as UTC midnight', () => {
    expect(parseDateUTC('Jun 5, 2026')!.toISOString()).toBe('2026-06-05T00:00:00.000Z');
    expect(parseDateUTC('June 5, 2026')!.toISOString()).toBe('2026-06-05T00:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseDateUTC('not a date')).toBeNull();
  });
});
