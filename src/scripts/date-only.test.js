import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isISODate, addDays, diffDays, weekdayIndex, addMonths, daysInMonth, monthEnd, shiftMonths,
  monthsBetween, formatDisplay, formatShort, formatLong, formatMonthTitle, nightsLabel,
} from './date-only.js';

test('isISODate accepts real calendar dates only', () => {
  assert.ok(isISODate('2026-10-12'));
  assert.ok(isISODate('2028-02-29'));
  assert.ok(!isISODate('2026-02-29'));
  assert.ok(!isISODate('2026-13-01'));
  assert.ok(!isISODate('12/10/2026'));
  assert.ok(!isISODate('2026-10-12T00:00:00Z'));
  assert.ok(!isISODate(undefined));
});

test('addDays crosses month, year and leap-day boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2026-10-12', 365), '2027-10-12');
});

test('diffDays counts whole days', () => {
  assert.equal(diffDays('2026-10-12', '2026-10-14'), 2);
  assert.equal(diffDays('2026-10-14', '2026-10-12'), -2);
  assert.equal(diffDays('2026-12-31', '2027-01-01'), 1);
});

test('weekdayIndex is Monday-first', () => {
  assert.equal(weekdayIndex('2026-10-12'), 0); // Monday
  assert.equal(weekdayIndex('2026-10-17'), 5); // Saturday
  assert.equal(weekdayIndex('2026-10-18'), 6); // Sunday
  assert.equal(weekdayIndex('1970-01-01'), 3); // Thursday
});

test('month helpers', () => {
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(daysInMonth('2026-02'), 28);
  assert.equal(daysInMonth('2028-02'), 29);
  assert.equal(monthEnd('2026-10'), '2026-10-31');
  assert.equal(shiftMonths('2026-01-31', 1), '2026-02-28');
  assert.deepEqual(monthsBetween('2026-10-28', '2026-12-02'), ['2026-10', '2026-11', '2026-12']);
});

test('formatting', () => {
  assert.equal(formatDisplay('2026-10-12'), '12/10/2026');
  assert.equal(formatShort('2026-10-17'), 'Sat 17 Oct');
  assert.equal(formatLong('2026-10-12'), 'Monday, 12 October 2026');
  assert.equal(formatMonthTitle('2026-10'), 'October 2026');
  assert.equal(nightsLabel(1), '1 night');
  assert.equal(nightsLabel(2), '2 nights');
});
