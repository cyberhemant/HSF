import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  bucketForTime,
  buildPickerPayload,
  enumerateDates,
  firstEnabledInRange,
  formatDateStripParts,
  formatTime,
  formatToken,
  isDateDisabledCore,
  resolveDefaultDate,
  resolveWindowBound,
  rollForwardDate,
  toISO,
  todayISO,
} from './date-time-slot-picker-logic.js';

test('resolveWindowBound resolves "today", relative offsets and literals', () => {
  const today = todayISO();
  assert.equal(resolveWindowBound('today'), today);
  assert.equal(resolveWindowBound('+30days'), addDays(today, 30));
  assert.equal(resolveWindowBound('-3days'), addDays(today, -3));
  assert.equal(resolveWindowBound('2026-12-25'), '2026-12-25');
});

test('addDays/toISO round-trip across a month boundary', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(toISO(new Date(2026, 8, 24)), '2026-09-24');
});

test('formatToken applies ddd/MMM/D/YYYY tokens', () => {
  // 2026-09-24 is a Thursday.
  assert.equal(formatToken('2026-09-24', 'ddd, MMM D'), 'Thu, Sep 24');
  assert.equal(formatToken('2026-09-24', 'MMM D, YYYY'), 'Sep 24, 2026');
  assert.equal(formatToken('2026-01-05', 'MM/DD/YYYY'), '01/05/2026');
});

test('formatDateStripParts splits on the first comma for the two-line pill', () => {
  assert.deepEqual(formatDateStripParts('2026-09-24', 'ddd, MMM D'), ['Thu', 'Sep 24']);
  // No comma: falls back to "ddd" on top, the whole format on bottom.
  assert.deepEqual(formatDateStripParts('2026-09-24', 'MMM D'), ['Thu', 'Sep 24']);
});

test('formatTime renders 12h and 24h, including midnight/noon edge cases', () => {
  assert.equal(formatTime('19:00', '12h'), '7:00 PM');
  assert.equal(formatTime('00:30', '12h'), '12:30 AM');
  assert.equal(formatTime('12:00', '12h'), '12:00 PM');
  assert.equal(formatTime('08:05', '24h'), '08:05');
});

test('bucketForTime categorizes Morning/Afternoon/Evening', () => {
  assert.equal(bucketForTime('08:00'), 'Morning');
  assert.equal(bucketForTime('11:59'), 'Morning');
  assert.equal(bucketForTime('12:00'), 'Afternoon');
  assert.equal(bucketForTime('16:59'), 'Afternoon');
  assert.equal(bucketForTime('17:00'), 'Evening');
});

test('isDateDisabledCore combines range, blacklist and rule', () => {
  const min = '2026-09-20';
  const max = '2026-10-20';
  const disabledSet = new Set(['2026-09-25']);
  const rule = (d) => new Date(`${d}T00:00:00`).getDay() === 5; // Friday
  assert.equal(isDateDisabledCore('2026-09-19', { min, max, disabledSet, rule }), true); // before min
  assert.equal(isDateDisabledCore('2026-10-21', { min, max, disabledSet, rule }), true); // after max
  assert.equal(isDateDisabledCore('2026-09-25', { min, max, disabledSet, rule }), true); // blacklisted
  assert.equal(isDateDisabledCore('2026-09-25', { min, max, disabledSet: new Set(), rule: null }), false);
  assert.equal(isDateDisabledCore('2026-09-25', { min, max, disabledSet: new Set(), rule }), true); // 2026-09-25 is a Friday
  assert.equal(isDateDisabledCore('2026-09-22', { min, max, disabledSet: new Set(), rule }), false); // a Tuesday
});

test('firstEnabledInRange / rollForwardDate skip disabled dates', () => {
  const min = '2026-09-21'; // Monday
  const max = '2026-09-27'; // Sunday
  const disabledSet = new Set(['2026-09-21']);
  const rule = (d) => new Date(`${d}T00:00:00`).getDay() === 5; // Friday (09-25) closed
  assert.equal(firstEnabledInRange({ min, max, disabledSet, rule }), '2026-09-22');
  assert.equal(rollForwardDate('2026-09-24', { min, max, disabledSet, rule }), '2026-09-26'); // skips Fri 25
  // Every date disabled: no enabled date exists.
  assert.equal(firstEnabledInRange({ min, max, disabledSet: new Set(), rule: () => true }), null);
});

test('resolveDefaultDate rolls forward from today when today is disabled', () => {
  const today = todayISO();
  const min = addDays(today, -5);
  const max = addDays(today, 5);
  const disabledSet = new Set([today]);
  const resolved = resolveDefaultDate({ min, max, disabledSet, rule: null });
  assert.equal(resolved, addDays(today, 1));
});

test('resolveDefaultDate warns and falls back when an explicit initialDate is disabled', () => {
  const today = todayISO();
  const min = addDays(today, -5);
  const max = addDays(today, 5);
  const disabledInitial = addDays(today, 2);
  const disabledSet = new Set([disabledInitial]);
  let warned = '';
  const resolved = resolveDefaultDate({
    initialDate: disabledInitial, min, max, disabledSet, rule: null, warn: (msg) => { warned = msg; },
  });
  assert.equal(resolved, firstEnabledInRange({ min, max, disabledSet, rule: null }));
  assert.match(warned, /initialDate/);
});

test('resolveDefaultDate keeps a valid explicit initialDate as-is', () => {
  const today = todayISO();
  const wanted = addDays(today, 3);
  const resolved = resolveDefaultDate({
    initialDate: wanted, min: addDays(today, -5), max: addDays(today, 5), disabledSet: new Set(), rule: null,
  });
  assert.equal(resolved, wanted);
});

test('enumerateDates is inclusive of both bounds', () => {
  assert.deepEqual(enumerateDates('2026-09-24', '2026-09-26'), ['2026-09-24', '2026-09-25', '2026-09-26']);
  assert.deepEqual(enumerateDates('2026-09-24', '2026-09-24'), ['2026-09-24']);
});

test('buildPickerPayload matches the §6 output contract', () => {
  const payload = buildPickerPayload({
    date: '2026-09-24',
    slot: { id: 'slot-1900', time: '19:00', status: 'available' },
    group: 'Evening',
    timeFormat: '12h',
  });
  assert.deepEqual(payload, {
    value: { date: '2026-09-24', time: '19:00', datetimeLocal: '2026-09-24T19:00' },
    slot: { id: 'slot-1900', status: 'available', group: 'Evening' },
    display: { date: 'Thu, Sep 24', time: '7:00 PM', combined: 'Sep 24, 2026 · 7:00 PM' },
  });
});

test('buildPickerPayload respects outputTimeFormat-independent 24h value.time', () => {
  const payload = buildPickerPayload({
    date: '2026-09-24',
    slot: { id: 's', time: '08:05', status: 'available' },
    group: 'Morning',
    timeFormat: '24h',
  });
  assert.equal(payload.value.time, '08:05'); // raw value is always 24h regardless of display timeFormat
  assert.equal(payload.display.time, '08:05');
});
