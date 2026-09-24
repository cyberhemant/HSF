// Pure logic for DatePicker.astro — no DOM, no Bootstrap import, so it runs
// under plain `node --test` (date-picker-logic.test.js). date-picker.js (the
// DOM controller) imports from here. Every date is a 'YYYY-MM-DD' string and
// every calculation goes through date-only.js's integer day numbers (§1, §13).

import {
  addDays, addMonths, daysInMonth, formatLong, isISODate, monthOf, monthStart, monthsBetween,
  shiftMonths, todayISO, weekdayIndex,
} from './date-only.js';

// §3 Availability states as the source reports them; anything else is `unknown`.
export const SOURCE_STATES = ['available', 'booked', 'disabled', 'unknown'];

// §2 Default window: today … today + 365 days.
export const DEFAULT_WINDOW_DAYS = 365;

// §11 setValue()/value/defaultValue: anything that isn't a real calendar date
// becomes null — silently, never throws.
export const normalizeValue = (value) => (isISODate(value) ? value : null);

// §2/§11 Builds the resolved rules object. `today` is injectable (setRules)
// so tests and demos don't depend on the clock.
export const resolveRules = ({ today, minDate, maxDate, blackoutDates } = {}) => {
  const resolvedToday = normalizeValue(today) ?? todayISO();
  const min = normalizeValue(minDate) ?? resolvedToday;
  const max = normalizeValue(maxDate) ?? addDays(resolvedToday, DEFAULT_WINDOW_DAYS);
  return {
    today: resolvedToday,
    // A past date is never selectable, whatever minDate says (§14).
    min: min < resolvedToday ? resolvedToday : min,
    max,
    blackout: new Set((blackoutDates ?? []).filter(isISODate)),
  };
};

// §5 A source may return a { 'YYYY-MM-DD': state } map or [{ date, status }]
// rows. Normalised to a Map; unrecognised states collapse to `unknown`.
export const normalizeAvailability = (result) => {
  const map = new Map();
  const entries = Array.isArray(result)
    ? result.map((row) => [row?.date, row?.status ?? row?.state])
    : Object.entries(result ?? {});
  for (const [date, state] of entries) {
    if (isISODate(date)) map.set(date, SOURCE_STATES.includes(state) ? state : 'unknown');
  }
  return map;
};

// §5 Only months that intersect the window are ever fetched.
export const monthInWindow = (month, { min, max }) => month >= monthOf(min) && month <= monthOf(max);

export const windowMonths = ({ min, max }) => monthsBetween(min, max);

// §3/§5 The single-date state of one day.
//   `availability` is null when there is no source (§5: every date in the
//   window is available), otherwise { status: 'loading'|'ready'|'error', map }
//   for the day's month — loading/error/missing-from-map are all `unknown`.
export const getSingleDateState = (iso, rules, availability = null) => {
  if (!isISODate(iso)) return 'disabled';
  if (iso < rules.min || iso > rules.max || rules.blackout.has(iso)) return 'disabled';
  if (!availability) return 'available';
  if (availability.status !== 'ready') return 'unknown';
  return availability.map.get(iso) ?? 'unknown';
};

// §3 The user-facing verdict. "booked" is internal only — the reason text
// says "unavailable" (§3, §14).
export const validateDate = (state) => {
  switch (state) {
    case 'available': return { ok: true };
    case 'booked': return { ok: false, code: 'date-booked', reason: 'That date is unavailable.' };
    case 'unknown': return { ok: false, code: 'unknown', reason: "Availability isn't known for this date yet." };
    default: return { ok: false, code: 'date-unavailable', reason: 'That date is unavailable.' };
  }
};

// §6 Accessible name of a day: "{formatLong}, {parts}, {state}". Always
// "unavailable", never "booked".
export const dayLabel = (iso, { state, selected, today }) => {
  const parts = [formatLong(iso)];
  if (today) parts.push('today');
  if (selected) parts.push('selected');
  parts.push(state === 'available' ? 'available' : state === 'unknown' ? 'availability unknown' : 'unavailable');
  return parts.join(', ');
};

// §6 Month grid: Monday-first rows of 7, leading/trailing null padding.
export const buildMonthWeeks = (month) => {
  const cells = [];
  for (let i = 0; i < weekdayIndex(monthStart(month)); i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth(month); d += 1) cells.push(`${month}-${String(d).padStart(2, '0')}`);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
};

export const clampDate = (iso, { min, max }) => (iso < min ? min : iso > max ? max : iso);

// §7 Where focus goes for a key, clamped to the window. Returns null for
// keys that don't move focus. Home/End are Monday/Sunday of the week.
export const moveFocusDate = (from, key, rules) => {
  let target;
  switch (key) {
    case 'ArrowLeft': target = addDays(from, -1); break;
    case 'ArrowRight': target = addDays(from, 1); break;
    case 'ArrowUp': target = addDays(from, -7); break;
    case 'ArrowDown': target = addDays(from, 7); break;
    case 'Home': target = addDays(from, -weekdayIndex(from)); break;
    case 'End': target = addDays(from, 6 - weekdayIndex(from)); break;
    case 'PageUp': target = shiftMonths(from, -1); break;
    case 'PageDown': target = shiftMonths(from, 1); break;
    default: return null;
  }
  return clampDate(target, rules);
};

// §6 Nav limits: the visible month can't leave the window's months.
export const canPageMonth = (month, delta, rules) => monthInWindow(addMonths(month, delta), rules);

// §10 Positioning geometry. All rects/viewports are in layout-viewport
// coordinates ({left, top, right, bottom}); the controller measures, this
// decides. Returns where the panel goes and whether it must shrink.
//   panel:  natural size { width, height } (max-height removed)
//   prevSide: last chosen side, for hysteresis — only flip when the current
//             side stops fitting, so the panel doesn't jitter while the
//             viewport settles (§10, §14).
export const computePlacement = ({ field, panel, viewport, prevSide = null, margin = 16, edge = 8, gap = 4, minHeight = 96 }) => {
  const marginLeft = Math.max(margin, viewport.insetLeft ?? 0);
  const marginRight = Math.max(margin, viewport.insetRight ?? 0);

  // Horizontal: align to the field's start edge, then clamp inside.
  const minLeft = viewport.left + marginLeft;
  const maxLeft = viewport.right - marginRight - panel.width;
  const left = maxLeft < minLeft ? minLeft : Math.min(Math.max(field.left, minLeft), maxLeft);

  // Vertical: available space on each side of the field.
  const top0 = viewport.top + (viewport.insetTop ?? 0);
  const below = Math.max(0, viewport.bottom - field.bottom - gap - edge);
  const above = Math.max(0, field.top - top0 - gap - edge);
  const fits = { below: panel.height <= below, above: panel.height <= above };

  let side;
  if (prevSide && fits[prevSide]) side = prevSide;
  else if (fits.below) side = 'below';
  else if (fits.above) side = 'above';
  else side = below >= above ? 'below' : 'above';

  const space = side === 'below' ? below : above;
  const maxHeight = fits[side] ? null : Math.max(space, minHeight);
  const height = maxHeight === null ? panel.height : Math.min(panel.height, maxHeight);

  let top = side === 'below' ? field.bottom + gap : field.top - gap - height;
  // Never cut off by an edge — clamp the finished box inside the viewport.
  top = Math.min(Math.max(top, top0 + edge), Math.max(viewport.bottom - edge - height, top0 + edge));

  return { side, left, top, maxHeight };
};

// §10 The field scrolled entirely out of the visual viewport → close.
export const isOutsideViewport = (rect, viewport) => (
  rect.bottom <= viewport.top || rect.top >= viewport.bottom || rect.right <= viewport.left || rect.left >= viewport.right
);

// §8 Outside-tap detection: pointerdown + pointerup on the same target with
// under ~10px of travel. Anything more is a scroll/drag, never a dismiss.
export const TAP_SLOP = 10;
export const isTap = (down, up, slop = TAP_SLOP) => (
  down.target === up.target && Math.hypot(up.x - down.x, up.y - down.y) < slop
);
