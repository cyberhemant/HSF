import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeValue, resolveRules, normalizeAvailability, getSingleDateState, validateDate, dayLabel,
  buildMonthWeeks, moveFocusDate, canPageMonth, computePlacement, isOutsideViewport, isTap, monthInWindow,
} from './date-picker-logic.js';

const rules = resolveRules({ today: '2026-10-12', minDate: '2026-10-12', maxDate: '2026-12-31', blackoutDates: ['2026-10-20'] });
const ready = (entries) => ({ status: 'ready', map: normalizeAvailability(entries) });

test('normalizeValue silently rejects impossible dates', () => {
  assert.equal(normalizeValue('2026-10-12'), '2026-10-12');
  assert.equal(normalizeValue('2026-02-30'), null);
  assert.equal(normalizeValue('2026-2-3'), null);
  assert.equal(normalizeValue('nonsense'), null);
  assert.equal(normalizeValue(undefined), null);
  assert.equal(normalizeValue(20261012), null);
});

test('resolveRules defaults to today … today+365 and never opens the past', () => {
  const r = resolveRules({ today: '2026-10-12' });
  assert.equal(r.min, '2026-10-12');
  assert.equal(r.max, '2027-10-12');
  assert.equal(resolveRules({ today: '2026-10-12', minDate: '2026-01-01' }).min, '2026-10-12');
  assert.equal(resolveRules({ today: '2026-10-12', minDate: 'garbage' }).min, '2026-10-12');
});

test('normalizeAvailability accepts maps and rows; unknown strings become unknown', () => {
  const fromMap = normalizeAvailability({ '2026-10-13': 'booked', '2026-10-14': 'available', '2026-10-15': 'weird', 'bad': 'available' });
  assert.equal(fromMap.get('2026-10-13'), 'booked');
  assert.equal(fromMap.get('2026-10-15'), 'unknown');
  assert.equal(fromMap.has('bad'), false);
  const fromRows = normalizeAvailability([{ date: '2026-10-13', status: 'available' }]);
  assert.equal(fromRows.get('2026-10-13'), 'available');
  assert.equal(normalizeAvailability(null).size, 0);
});

test('getSingleDateState: window, blackout, min/max inclusive', () => {
  assert.equal(getSingleDateState('2026-10-11', rules), 'disabled'); // past
  assert.equal(getSingleDateState('2026-10-12', rules), 'available'); // minDate selectable
  assert.equal(getSingleDateState('2026-12-31', rules), 'available'); // maxDate selectable
  assert.equal(getSingleDateState('2027-01-01', rules), 'disabled');
  assert.equal(getSingleDateState('2026-10-20', rules), 'disabled'); // blackout
  assert.equal(getSingleDateState('2026-02-30', rules), 'disabled'); // not a date
});

test('getSingleDateState: no source → available; missing/loading/error → unknown', () => {
  assert.equal(getSingleDateState('2026-10-14', rules, null), 'available');
  assert.equal(getSingleDateState('2026-10-14', rules, ready({})), 'unknown');
  assert.equal(getSingleDateState('2026-10-14', rules, ready({ '2026-10-14': 'available' })), 'available');
  assert.equal(getSingleDateState('2026-10-14', rules, ready({ '2026-10-14': 'booked' })), 'booked');
  assert.equal(getSingleDateState('2026-10-14', rules, { status: 'loading', map: new Map() }), 'unknown');
  assert.equal(getSingleDateState('2026-10-14', rules, { status: 'error', map: new Map() }), 'unknown');
  // window wins over the source
  assert.equal(getSingleDateState('2026-10-20', rules, ready({ '2026-10-20': 'available' })), 'disabled');
});

test('validateDate wording never says "booked"', () => {
  assert.deepEqual(validateDate('available'), { ok: true });
  assert.deepEqual(validateDate('booked'), { ok: false, code: 'date-booked', reason: 'That date is unavailable.' });
  assert.deepEqual(validateDate('unknown'), { ok: false, code: 'unknown', reason: "Availability isn't known for this date yet." });
  assert.deepEqual(validateDate('disabled'), { ok: false, code: 'date-unavailable', reason: 'That date is unavailable.' });
  for (const s of ['booked', 'unknown', 'disabled']) assert.ok(!/booked/i.test(validateDate(s).reason));
});

test('dayLabel matches the spec examples', () => {
  assert.equal(dayLabel('2026-10-17', { state: 'available', selected: true }), 'Saturday, 17 October 2026, selected, available');
  assert.equal(dayLabel('2026-10-18', { state: 'booked', today: true }), 'Sunday, 18 October 2026, today, unavailable');
  assert.ok(!/booked/i.test(dayLabel('2026-10-18', { state: 'booked' })));
});

test('buildMonthWeeks pads Monday-first', () => {
  const oct = buildMonthWeeks('2026-10'); // 1 Oct 2026 is a Thursday
  assert.deepEqual(oct[0].slice(0, 4), [null, null, null, '2026-10-01']);
  assert.equal(oct.length, 5);
  assert.ok(oct.every((w) => w.length === 7));
  assert.equal(oct.flat().filter(Boolean).length, 31);
  assert.equal(buildMonthWeeks('2026-02').flat().filter(Boolean).length, 28);
  assert.equal(buildMonthWeeks('2028-02').flat().filter(Boolean).length, 29);
  assert.equal(buildMonthWeeks('2026-08').length, 6); // starts Saturday, 31 days
});

test('moveFocusDate: arrows, week edges, month paging, clamping', () => {
  assert.equal(moveFocusDate('2026-10-14', 'ArrowRight', rules), '2026-10-15');
  assert.equal(moveFocusDate('2026-10-14', 'ArrowLeft', rules), '2026-10-13');
  assert.equal(moveFocusDate('2026-10-14', 'ArrowDown', rules), '2026-10-21');
  assert.equal(moveFocusDate('2026-10-14', 'ArrowUp', rules), '2026-10-12'); // 7 back = 07 → clamped to min
  assert.equal(moveFocusDate('2026-10-14', 'Home', rules), '2026-10-12'); // Monday
  assert.equal(moveFocusDate('2026-10-14', 'End', rules), '2026-10-18'); // Sunday
  assert.equal(moveFocusDate('2026-10-31', 'PageDown', rules), '2026-11-30'); // clamp day
  assert.equal(moveFocusDate('2026-11-30', 'PageUp', rules), '2026-10-30');
  assert.equal(moveFocusDate('2026-12-31', 'ArrowRight', rules), '2026-12-31'); // clamps at max
  assert.equal(moveFocusDate('2026-12-31', 'PageDown', rules), '2026-12-31');
  assert.equal(moveFocusDate('2026-10-14', 'a', rules), null);
});

test('month paging limits follow the window', () => {
  assert.ok(monthInWindow('2026-11', rules));
  assert.ok(!monthInWindow('2026-09', rules));
  assert.ok(!canPageMonth('2026-10', -1, rules));
  assert.ok(canPageMonth('2026-10', 1, rules));
  assert.ok(!canPageMonth('2026-12', 1, rules));
});

// ---- §10 placement -----------------------------------------------------------

const viewport = { left: 0, top: 0, right: 390, bottom: 800 };
const panel = { width: 352, height: 420 };

test('placement: prefers below, aligns to the field start, clamps horizontally', () => {
  const p = computePlacement({ field: { left: 20, top: 100, bottom: 150 }, panel, viewport });
  assert.equal(p.side, 'below');
  assert.equal(p.top, 154);
  assert.equal(p.left, 20);
  assert.equal(p.maxHeight, null);
  // near the right edge → clamped inside the margin
  const r = computePlacement({ field: { left: 300, top: 100, bottom: 150 }, panel, viewport });
  assert.equal(r.left, 390 - 16 - 352);
});

test('placement: flips above when below is too short and above fits', () => {
  const p = computePlacement({ field: { left: 20, top: 600, bottom: 650 }, panel, viewport });
  assert.equal(p.side, 'above');
  assert.equal(p.top, 600 - 4 - 420);
  assert.equal(p.maxHeight, null);
});

test('placement: neither side fits → larger side, shrunk with a max-height', () => {
  const short = { left: 0, top: 0, right: 700, bottom: 320 }; // landscape phone
  const p = computePlacement({ field: { left: 20, top: 120, bottom: 170 }, panel, viewport: short });
  assert.equal(p.side, 'below');
  assert.equal(p.maxHeight, 320 - 170 - 4 - 8);
  assert.ok(p.top + p.maxHeight <= 320 - 8 + 0.001);
  const flipped = computePlacement({ field: { left: 20, top: 200, bottom: 250 }, panel, viewport: short });
  assert.equal(flipped.side, 'above');
  assert.ok(flipped.top >= 8);
});

test('placement: hysteresis keeps the current side while it still fits', () => {
  // both sides fit in a 1000px viewport; below would win fresh, but above was chosen before
  const tall = { left: 0, top: 0, right: 390, bottom: 1000 };
  const both = { left: 20, top: 500, bottom: 550 };
  assert.equal(computePlacement({ field: both, panel, viewport: tall }).side, 'below');
  assert.equal(computePlacement({ field: both, panel, viewport: tall, prevSide: 'above' }).side, 'above');
  // once the previous side stops fitting, it flips
  const tight = { left: 20, top: 200, bottom: 700 };
  assert.equal(computePlacement({ field: tight, panel, viewport, prevSide: 'below' }).side, 'above');
});

test('placement: safe-area insets widen the horizontal margin', () => {
  const p = computePlacement({ field: { left: 0, top: 100, bottom: 150 }, panel: { width: 300, height: 300 }, viewport: { ...viewport, insetLeft: 47 } });
  assert.equal(p.left, 47);
});

test('placement: a fixed header (insetTop) is treated as unavailable space above', () => {
  const p = computePlacement({ field: { left: 20, top: 500, bottom: 550 }, panel: { width: 352, height: 480 }, viewport: { ...viewport, bottom: 600, insetTop: 80 } });
  assert.equal(p.side, 'above');
  assert.ok(p.top >= 80 + 8);
});

test('field out of the visual viewport is detected', () => {
  assert.ok(isOutsideViewport({ left: 0, right: 100, top: -80, bottom: -10 }, viewport));
  assert.ok(isOutsideViewport({ left: 0, right: 100, top: 900, bottom: 950 }, viewport));
  assert.ok(!isOutsideViewport({ left: 0, right: 100, top: 700, bottom: 850 }, viewport));
});

test('isTap: same target and < 10px travel only', () => {
  const t = {};
  assert.ok(isTap({ target: t, x: 10, y: 10 }, { target: t, x: 13, y: 12 }));
  assert.ok(!isTap({ target: t, x: 10, y: 10 }, { target: t, x: 10, y: 40 })); // scroll gesture
  assert.ok(!isTap({ target: t, x: 10, y: 10 }, { target: {}, x: 10, y: 10 }));
});
