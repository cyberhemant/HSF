import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekdayIndex } from './date-only.js';
import {
  normalizeAvailability, calculateNights, getMinimumNights, getMaximumNights, getDateState,
  validateRange, formatSummary, thisWeekend, getSingleDateState, validateDate,
} from './lodge-date-rules.js';

// Fixed "today" = Monday 12 Oct 2026. Window: today → +365 days.
const TODAY = '2026-10-12';
const rules = (overrides = {}) => ({
  minDate: TODAY,
  maxDate: '2027-10-12',
  blackoutDates: [],
  availability: null,
  ...overrides,
});
const avail = (map) => ({ availability: map });

// ---- Nights & summary -------------------------------------------------------

test('calculateNights', () => {
  assert.equal(calculateNights('2026-10-12', '2026-10-14'), 2);
  assert.equal(calculateNights('2026-10-31', '2026-11-02'), 2);
});

test('summary reads "Sat 17 Oct → Mon 19 Oct · 2 nights"', () => {
  assert.equal(formatSummary('2026-10-17', '2026-10-19'), 'Sat 17 Oct → Mon 19 Oct · 2 nights');
  assert.equal(formatSummary('2026-10-17', '2026-10-18'), 'Sat 17 Oct → Sun 18 Oct · 1 night');
});

// ---- Date boundaries --------------------------------------------------------

test('past dates are disabled', () => {
  assert.equal(getDateState('2026-10-11', rules()), 'disabled');
  assert.equal(validateRange('2026-10-10', '2026-10-13', rules()).code, 'start-unavailable');
});

test('minDate is respected: the day itself is allowed', () => {
  assert.equal(getDateState('2026-10-12', rules()), 'available');
  assert.equal(getDateState('2026-10-14', rules({ minDate: '2026-10-15' })), 'disabled');
});

test('maxDate is respected: the day itself is allowed', () => {
  assert.equal(getDateState('2027-10-12', rules()), 'available');
  assert.equal(getDateState('2027-10-13', rules()), 'disabled');
  assert.equal(validateRange('2027-10-11', '2027-10-13', rules()).code, 'end-unavailable');
});

test('blackout dates are disabled (array or Set)', () => {
  assert.equal(getDateState('2026-10-20', rules({ blackoutDates: ['2026-10-20'] })), 'disabled');
  assert.equal(getDateState('2026-10-20', rules({ blackoutDates: new Set(['2026-10-20']) })), 'disabled');
});

test('a blackout date inside a stay rejects the stay', () => {
  const result = validateRange('2026-10-19', '2026-10-22', rules({ blackoutDates: ['2026-10-20'] }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unavailable-night');
});

// ---- Availability -----------------------------------------------------------

test('available dates work as check-in and check-out', () => {
  const r = rules(avail({ '2026-10-20': 'available', '2026-10-22': 'available', '2026-10-21': 'available' }));
  assert.deepEqual(validateRange('2026-10-20', '2026-10-22', r), { ok: true, nights: 2 });
});

test('booked dates are not selectable as either end', () => {
  const r = rules(avail({ '2026-10-20': 'booked', '2026-10-21': 'available', '2026-10-22': 'booked' }));
  assert.equal(validateRange('2026-10-20', '2026-10-21', r).code, 'start-unavailable');
  assert.equal(validateRange('2026-10-21', '2026-10-22', r).code, 'end-unavailable');
});

test('check-in-only is usable only as the start', () => {
  const r = rules(avail({ '2026-10-20': 'checkin-only', '2026-10-21': 'available', '2026-10-19': 'available' }));
  assert.equal(validateRange('2026-10-20', '2026-10-21', r).ok, true);
  const asEnd = validateRange('2026-10-19', '2026-10-20', r);
  assert.equal(asEnd.ok, false);
  assert.equal(asEnd.code, 'end-checkin-only');
  assert.equal(asEnd.reason, 'This date is available for check-in only.');
});

test('check-out-only is usable only as the end', () => {
  const r = rules(avail({ '2026-10-20': 'checkout-only', '2026-10-19': 'available', '2026-10-21': 'available' }));
  assert.equal(validateRange('2026-10-19', '2026-10-20', r).ok, true);
  const asStart = validateRange('2026-10-20', '2026-10-21', r);
  assert.equal(asStart.ok, false);
  assert.equal(asStart.code, 'start-checkout-only');
  assert.equal(asStart.reason, 'This date is available for check-out only.');
});

test('same-day turnover: check-out-only end and check-in-only start on the same date', () => {
  // A stay ends on the 20th, another begins on the 20th.
  const before = rules(avail({ '2026-10-19': 'available', '2026-10-20': 'checkout-only' }));
  const after = rules(avail({ '2026-10-20': 'checkin-only', '2026-10-21': 'available' }));
  assert.equal(validateRange('2026-10-19', '2026-10-20', before).ok, true);
  assert.equal(validateRange('2026-10-20', '2026-10-21', after).ok, true);
});

test('dates missing from the availability map are unknown, never available', () => {
  const r = rules(avail({}));
  assert.equal(getDateState('2026-10-20', r), 'unknown');
  const result = validateRange('2026-10-20', '2026-10-22', r);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown');
});

test('with no availability source configured, in-window dates are available', () => {
  assert.equal(getDateState('2026-10-20', rules({ availability: null })), 'available');
});

test('adapter normalises maps and rows, and drops anything unrecognised', () => {
  assert.deepEqual(
    normalizeAvailability({ '2026-10-20': 'booked', '2026-10-21': 'maybe', 'bad': 'available' }),
    { '2026-10-20': 'booked' },
  );
  assert.deepEqual(
    normalizeAvailability([{ date: '2026-10-20', status: 'checkin-only' }, { date: '2026-10-21', state: 'available' }, { date: 'x' }]),
    { '2026-10-20': 'checkin-only', '2026-10-21': 'available' },
  );
  assert.deepEqual(normalizeAvailability(null), {});
});

// ---- Stay rules -------------------------------------------------------------

test('same-day range is rejected', () => {
  const result = validateRange('2026-10-20', '2026-10-20', rules());
  assert.equal(result.code, 'same-day');
});

test('end before start is rejected', () => {
  assert.equal(validateRange('2026-10-22', '2026-10-20', rules()).code, 'end-before-start');
});

test('minimum nights', () => {
  const r = rules({ minNights: 2 });
  const short = validateRange('2026-10-20', '2026-10-21', r);
  assert.equal(short.code, 'min-nights');
  assert.equal(short.reason, 'Minimum stay is 2 nights.');
  assert.equal(validateRange('2026-10-20', '2026-10-22', r).ok, true);
});

test('maximum nights', () => {
  const r = rules({ maxNights: 14 });
  const long = validateRange('2026-10-20', '2026-11-04', r);
  assert.equal(long.code, 'max-nights');
  assert.equal(long.reason, 'Maximum stay is 14 nights.');
  assert.equal(validateRange('2026-10-20', '2026-11-03', r).ok, true);
});

test('minimum nights can depend on the start date (weekends need 2)', () => {
  const weekendsNeedTwo = (start) => (weekdayIndex(start) >= 4 ? 2 : 1); // Fri, Sat, Sun
  const r = rules({ minNights: weekendsNeedTwo });
  assert.equal(getMinimumNights(r, '2026-10-14'), 1); // Wednesday
  assert.equal(getMinimumNights(r, '2026-10-16'), 2); // Friday
  assert.equal(validateRange('2026-10-14', '2026-10-15', r).ok, true);
  assert.equal(validateRange('2026-10-16', '2026-10-17', r).code, 'min-nights');
  assert.equal(validateRange('2026-10-16', '2026-10-18', r).ok, true);
});

test('maximum nights can be a function of the start date', () => {
  const r = rules({ maxNights: (start) => (weekdayIndex(start) === 0 ? 3 : 14) });
  assert.equal(getMaximumNights(r, '2026-10-12'), 3);
  assert.equal(validateRange('2026-10-12', '2026-10-16', r).code, 'max-nights');
});

test('nonsense night rules fall back to 1 minimum and no maximum', () => {
  const r = rules({ minNights: 0, maxNights: 'lots' });
  assert.equal(getMinimumNights(r, TODAY), 1);
  assert.equal(getMaximumNights(r, TODAY), Infinity);
});

test('a booked night inside the range rejects the whole range', () => {
  // 12 available, 13 booked, 14 available: 12 → 14 must be rejected.
  const r = rules(avail({ '2026-10-20': 'available', '2026-10-21': 'booked', '2026-10-22': 'available' }));
  const result = validateRange('2026-10-20', '2026-10-22', r);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'booked-night');
  assert.equal(result.reason, 'This stay includes a booked night.');
});

test('a check-in-only or check-out-only date inside a stay also rejects it', () => {
  const inside = (state) => rules(avail({ '2026-10-20': 'available', '2026-10-21': state, '2026-10-22': 'available' }));
  assert.equal(validateRange('2026-10-20', '2026-10-22', inside('checkin-only')).code, 'booked-night');
  assert.equal(validateRange('2026-10-20', '2026-10-22', inside('checkout-only')).code, 'booked-night');
});

test('an unknown date inside a stay rejects it rather than assuming it is free', () => {
  const r = rules(avail({ '2026-10-20': 'available', '2026-10-22': 'available' }));
  assert.equal(validateRange('2026-10-20', '2026-10-22', r).code, 'unknown');
});

// ---- Preset -----------------------------------------------------------------

test('"this weekend" is Fri → Sun, and adapts on Saturday and Sunday', () => {
  assert.deepEqual(thisWeekend('2026-10-12'), { start: '2026-10-16', end: '2026-10-18' }); // Mon
  assert.deepEqual(thisWeekend('2026-10-16'), { start: '2026-10-16', end: '2026-10-18' }); // Fri
  assert.deepEqual(thisWeekend('2026-10-17'), { start: '2026-10-17', end: '2026-10-18' }); // Sat
  assert.deepEqual(thisWeekend('2026-10-18'), { start: '2026-10-23', end: '2026-10-25' }); // Sun
});

test('the preset is still validated by the normal rules', () => {
  const r = rules(avail({ '2026-10-16': 'available', '2026-10-17': 'booked', '2026-10-18': 'available' }));
  const { start, end } = thisWeekend('2026-10-12');
  assert.equal(validateRange(start, end, r).code, 'booked-night');
});

// ---- Single date ------------------------------------------------------------

test('single date: available is selectable', () => {
  const r = rules(avail({ '2026-10-20': 'available' }));
  assert.deepEqual(validateDate('2026-10-20', r), { ok: true });
});

test('single date: a taken date is rejected as "unavailable", never "booked"', () => {
  const r = rules(avail({ '2026-10-20': 'booked' }));
  const result = validateDate('2026-10-20', r);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'date-booked');
  assert.equal(result.reason, 'That date is unavailable.');
  assert.doesNotMatch(result.reason, /booked/i);
});

test('single date: check-in-only and check-out-only count as available', () => {
  assert.equal(getSingleDateState('2026-10-20', rules(avail({ '2026-10-20': 'checkin-only' }))), 'available');
  assert.equal(validateDate('2026-10-20', rules(avail({ '2026-10-20': 'checkout-only' }))).ok, true);
});

test('single date: past, outside the window and blackout dates are unavailable', () => {
  assert.equal(validateDate('2026-10-11', rules()).code, 'date-unavailable');
  assert.equal(validateDate('2026-10-11', rules()).reason, 'That date is unavailable.');
  assert.equal(validateDate('2027-10-13', rules()).code, 'date-unavailable');
  assert.equal(validateDate('2026-10-20', rules({ blackoutDates: ['2026-10-20'] })).code, 'date-unavailable');
  assert.equal(validateDate('2026-10-12', rules()).ok, true); // minDate itself
  assert.equal(validateDate('2027-10-12', rules()).ok, true); // maxDate itself
});

test('single date: a date missing from the availability map is unknown, never available', () => {
  assert.equal(validateDate('2026-10-20', rules(avail({}))).code, 'unknown');
  assert.equal(validateDate('2026-10-20', rules({ availability: null })).ok, true); // no source configured
});
