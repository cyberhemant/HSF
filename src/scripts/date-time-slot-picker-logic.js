// Pure date/format/payload logic for the Date & Time Slot Picker — no DOM,
// no Bootstrap import, so it can run under plain `node --test`
// (date-time-slot-picker.test.js) without a bundler. date-time-slot-picker.js
// (the DOM controller, which does need Bootstrap) imports from here; kept
// separate for the same reason the deleted date picker split
// lodge-date-rules.js from date-range-picker.js.

export const PERIODS = ['Morning', 'Afternoon', 'Evening'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (n) => String(n).padStart(2, '0');

// Always built from y/m/d components (never `new Date(isoString)`, which
// parses as UTC and can land on the wrong local day) — no timezone handling
// beyond that, per the component's own non-goal.
export function parseISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toISO(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function todayISO() {
  return toISO(new Date());
}

export function addDays(dateStr, n) {
  const d = parseISO(dateStr);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

// "today" | "+30days" | "-3days" | "2026-10-06" → "YYYY-MM-DD"
export function resolveWindowBound(spec) {
  if (spec === 'today') return todayISO();
  const m = /^([+-]\d+)days$/.exec(String(spec));
  if (m) return addDays(todayISO(), Number(m[1]));
  return spec;
}

export function formatToken(dateStr, format) {
  const d = parseISO(dateStr);
  return format.replace(/YYYY|MMM|ddd|DD|MM|D|M/g, (token) => {
    switch (token) {
      case 'YYYY': return String(d.getFullYear());
      case 'MMM': return MON[d.getMonth()];
      case 'ddd': return DOW[d.getDay()];
      case 'DD': return pad2(d.getDate());
      case 'MM': return pad2(d.getMonth() + 1);
      case 'D': return String(d.getDate());
      case 'M': return String(d.getMonth() + 1);
      default: return token;
    }
  });
}

// dateFormat's two comma-separated halves become the date-strip pill's two
// lines ("ddd" over "MMM D" for the default "ddd, MMM D"); a format with no
// comma renders on the bottom line only, top line falls back to "ddd".
export function formatDateStripParts(dateStr, format) {
  const [first, ...rest] = String(format).split(',');
  const bottom = rest.length ? rest.join(',').trim() : first.trim();
  const top = rest.length ? first.trim() : 'ddd';
  return [formatToken(dateStr, top), formatToken(dateStr, bottom)];
}

export function formatTime(hhmm, timeFormat) {
  const [hStr, mStr] = String(hhmm).split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (timeFormat === '24h') return `${pad2(h)}:${pad2(m)}`;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad2(m)} ${period}`;
}

export function bucketForTime(hhmm) {
  const hour = Number(String(hhmm).split(':')[0]);
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  return 'Evening';
}

const inRange = (date, min, max) => date >= min && date <= max;

export function isDateDisabledCore(date, { min, max, disabledSet, rule }) {
  if (!inRange(date, min, max)) return true;
  if (disabledSet.has(date)) return true;
  return Boolean(rule && rule(date));
}

export function firstEnabledInRange({ min, max, disabledSet, rule }) {
  let d = min;
  while (d <= max) {
    if (!isDateDisabledCore(d, { min, max, disabledSet, rule })) return d;
    d = addDays(d, 1);
  }
  return null;
}

export function rollForwardDate(from, { min, max, disabledSet, rule }) {
  let d = addDays(from, 1);
  while (d <= max) {
    if (!isDateDisabledCore(d, { min, max, disabledSet, rule })) return d;
    d = addDays(d, 1);
  }
  return null;
}

// Today (or the first enabled date after it) unless an explicit initialDate
// was given — an explicit date that resolves disabled is a config error:
// fall back to the first enabled date in range and warn, per §3.
export function resolveDefaultDate({ initialDate, min, max, disabledSet, rule, warn = () => {} }) {
  if (initialDate) {
    if (!isDateDisabledCore(initialDate, { min, max, disabledSet, rule })) return initialDate;
    warn(`DateTimeSlotPicker: initialDate "${initialDate}" is disabled; falling back to the first enabled date in range.`);
    return firstEnabledInRange({ min, max, disabledSet, rule }) ?? initialDate;
  }
  const today = todayISO();
  if (!isDateDisabledCore(today, { min, max, disabledSet, rule })) return today;
  return rollForwardDate(today, { min, max, disabledSet, rule }) ?? firstEnabledInRange({ min, max, disabledSet, rule }) ?? today;
}

export function enumerateDates(min, max) {
  const dates = [];
  let d = min;
  while (d <= max) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

// §6 output payload. display.date/combined use a fixed contract format
// (independent of the configurable `dateFormat`, which only styles the
// date-strip/trigger UI) — matches the spec's own literal examples.
export function buildPickerPayload({ date, slot, group, timeFormat }) {
  return {
    value: {
      date,
      time: slot.time,
      datetimeLocal: `${date}T${slot.time}`,
    },
    slot: { id: slot.id, status: slot.status, group },
    display: {
      date: formatToken(date, 'ddd, MMM D'),
      time: formatTime(slot.time, timeFormat),
      combined: `${formatToken(date, 'MMM D, YYYY')} · ${formatTime(slot.time, timeFormat)}`,
    },
  };
}
