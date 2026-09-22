// Lodge stay and date rules — pure functions, no DOM, no Date objects. Everything works
// on 'YYYY-MM-DD' strings via date-only.js, so the rules are testable on their
// own (see lodge-date-rules.test.js) and never touch the screen.
//
// A stay is a check-in date and a check-out date; the nights are the dates from
// check-in up to, but not including, check-out.
//
// Availability says, per date, what a stay may do there:
//   available      night before and night of this date are both free
//   checkin-only   only a stay may START here (the night before is taken)
//   checkout-only  only a stay may END here (the night of this date is taken)
//   booked         neither: the date sits inside someone else's stay
// The API is the source of truth for same-day turnover; nothing here invents it.
// A date the map doesn't mention is 'unknown' (still loading, or failed to load)
// and is never selectable — unknown is not the same as available.
import { addDays, diffDays, weekdayIndex, formatShort, nightsLabel } from './date-only.js';

export const AVAILABILITY_STATES = ['available', 'booked', 'checkin-only', 'checkout-only'];

// Adapter: whatever the backend returns → { 'YYYY-MM-DD': AvailabilityState }.
// Accepts a ready-made map, or a list of { date, status } rows. Rows with an
// invalid date or an unrecognised status are dropped, which leaves those dates
// unknown (and so unselectable) rather than silently available.
export const normalizeAvailability = (raw) => {
  const rows = Array.isArray(raw)
    ? raw.map((row) => [row?.date, row?.status ?? row?.state])
    : Object.entries(raw ?? {});
  const map = {};
  rows.forEach(([date, status]) => {
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && AVAILABILITY_STATES.includes(status)) {
      map[date] = status;
    }
  });
  return map;
};

// ---- Nights ----------------------------------------------------------------

export const calculateNights = (start, end) => diffDays(start, end);

const resolveNights = (rule, start, fallback) => {
  const n = typeof rule === 'function' ? rule(start) : rule;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
};

// `minNights` / `maxNights` are a number or (startDate) => number, so rules like
// "weekends need 2 nights" are configuration, not code in here.
export const getMinimumNights = (rules, start) => resolveNights(rules.minNights, start, 1);
export const getMaximumNights = (rules, start) => resolveNights(rules.maxNights, start, Infinity);

// ---- Per-date state --------------------------------------------------------

// 'disabled' | 'unknown' | AvailabilityState.
// rules: { minDate, maxDate, blackoutDates?, availability }
// `availability: null` means no availability source is configured, so every
// date inside the booking window is available.
export const getDateState = (iso, rules) => {
  const { minDate, maxDate, blackoutDates = [], availability } = rules;
  if (iso < minDate || iso > maxDate) return 'disabled';
  if (blackoutDates instanceof Set ? blackoutDates.has(iso) : blackoutDates.includes(iso)) return 'disabled';
  if (availability == null) return 'available';
  const state = availability[iso];
  return AVAILABILITY_STATES.includes(state) ? state : 'unknown';
};

export const canStartOn = (state) => state === 'available' || state === 'checkin-only';
export const canEndOn = (state) => state === 'available' || state === 'checkout-only';

// ---- Range validation ------------------------------------------------------

const fail = (code, reason) => ({ ok: false, code, reason });

// { ok: true, nights } or { ok: false, code, reason }. `reason` is the message
// shown to the guest. Order matters: shape, then each end, then the stay length,
// then every night in between.
export const validateRange = (start, end, rules) => {
  if (end === start) return fail('same-day', 'Check-out must be after check-in.');
  if (end < start) return fail('end-before-start', 'Check-out must be after check-in.');

  const startState = getDateState(start, rules);
  const endState = getDateState(end, rules);
  if (startState === 'unknown' || endState === 'unknown') {
    return fail('unknown', "Availability isn't known for these dates yet.");
  }
  if (startState === 'checkout-only') return fail('start-checkout-only', 'This date is available for check-out only.');
  if (!canStartOn(startState)) return fail('start-unavailable', "That check-in date isn't available.");
  if (endState === 'checkin-only') return fail('end-checkin-only', 'This date is available for check-in only.');
  if (!canEndOn(endState)) return fail('end-unavailable', "That check-out date isn't available.");

  const nights = calculateNights(start, end);
  const min = getMinimumNights(rules, start);
  if (nights < min) return fail('min-nights', `Minimum stay is ${nightsLabel(min)}.`);
  const max = getMaximumNights(rules, start);
  if (nights > max) return fail('max-nights', `Maximum stay is ${nightsLabel(max)}.`);

  // Dates strictly between the two ends: each one has a night on both sides
  // inside the stay, so it must be fully available.
  for (let d = addDays(start, 1); d < end; d = addDays(d, 1)) {
    const state = getDateState(d, rules);
    if (state === 'available') continue;
    if (state === 'unknown') return fail('unknown', "Availability isn't known for every night of this stay yet.");
    if (state === 'disabled') return fail('unavailable-night', 'This stay includes an unavailable date.');
    return fail('booked-night', 'This stay includes a booked night.');
  }

  return { ok: true, nights };
};

// ---- Single date -----------------------------------------------------------

// Check-in-only and check-out-only describe the edges of a stay, which mean
// nothing for one day, so for a single date they count as available. A date is
// usable unless it is disabled, booked or unknown. A single date never says
// "booked": to the guest a taken date is simply unavailable, like a past one.
// The two codes stay apart only so the picker can tell a taken date (which
// explains itself when clicked) from a disabled one (which is inert).
export const getSingleDateState = (iso, rules) => {
  const state = getDateState(iso, rules);
  return state === 'checkin-only' || state === 'checkout-only' ? 'available' : state;
};

// { ok: true } or { ok: false, code, reason }.
export const validateDate = (iso, rules) => {
  const state = getSingleDateState(iso, rules);
  if (state === 'available') return { ok: true };
  if (state === 'booked') return fail('date-booked', 'That date is unavailable.');
  if (state === 'unknown') return fail('unknown', "Availability isn't known for this date yet.");
  return fail('date-unavailable', 'That date is unavailable.');
};

// ---- Summary ---------------------------------------------------------------

// Sat 12 Oct → Mon 14 Oct · 2 nights
export const formatSummary = (start, end) => (
  `${formatShort(start)} → ${formatShort(end)} · ${nightsLabel(calculateNights(start, end))}`
);

// ---- Presets ---------------------------------------------------------------

// "This weekend": Friday → Sunday (2 nights) of the current week. On a Saturday
// it is that night only (Sat → Sun); on a Sunday the weekend is over, so it
// means the coming one. The result still goes through validateRange, so a stay
// rule such as "weekends need 2 nights" can reject it with a reason.
export const thisWeekend = (today) => {
  const day = weekdayIndex(today);
  if (day === 5) return { start: today, end: addDays(today, 1) };
  const start = addDays(today, day === 6 ? 5 : 4 - day);
  return { start, end: addDays(start, 2) };
};
