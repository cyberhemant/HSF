// Date-only helpers. A booking date is a calendar date, not a moment in time,
// so every value here is a plain 'YYYY-MM-DD' string (months: 'YYYY-MM') and
// every calculation is integer arithmetic on a day number. Nothing in this file
// builds a Date from a booking date, so a time zone can never shift one.
//
// The only clock read is todayISO(), which asks Intl what the calendar date is
// right now in the farm's time zone.

// The farm has one fixed time zone (v1). Oman: UTC+4, no daylight saving.
export const FARM_TIME_ZONE = 'Asia/Muscat';

// The week starts on Monday (fixed for v1). weekdayIndex(): Mon 0 … Sun 6.
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const pad = (n, width = 2) => String(n).padStart(width, '0');

// Howard Hinnant's civil-calendar algorithms: days since 1970-01-01 ⇄ y/m/d.
const daysFromCivil = (year, month, day) => {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const civilFromDays = (days) => {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  return [yoe + era * 400 + (month <= 2 ? 1 : 0), month, day];
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})$/;

export const isISODate = (value) => {
  const match = typeof value === 'string' ? ISO_DATE.exec(value) : null;
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const [ry, rm, rd] = civilFromDays(daysFromCivil(y, m, d));
  return ry === y && rm === m && rd === d;
};

export const isISOMonth = (value) => {
  const match = typeof value === 'string' ? ISO_MONTH.exec(value) : null;
  return Boolean(match) && Number(match[2]) >= 1 && Number(match[2]) <= 12;
};

export const toDayNumber = (iso) => {
  const [y, m, d] = ISO_DATE.exec(iso).slice(1).map(Number);
  return daysFromCivil(y, m, d);
};

export const fromDayNumber = (days) => {
  const [y, m, d] = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
};

export const addDays = (iso, days) => fromDayNumber(toDayNumber(iso) + days);

// Whole days from a to b (b later → positive).
export const diffDays = (a, b) => toDayNumber(b) - toDayNumber(a);

// Mon 0 … Sun 6. 1970-01-01 was a Thursday.
export const weekdayIndex = (iso) => (((toDayNumber(iso) + 3) % 7) + 7) % 7;

export const monthOf = (iso) => iso.slice(0, 7);

const parseMonth = (month) => ISO_MONTH.exec(month).slice(1).map(Number);

export const addMonths = (month, delta) => {
  const [y, m] = parseMonth(month);
  const total = y * 12 + (m - 1) + delta;
  return `${pad(Math.floor(total / 12), 4)}-${pad((total % 12) + 1)}`;
};

export const monthStart = (month) => `${month}-01`;

export const daysInMonth = (month) => diffDays(monthStart(month), monthStart(addMonths(month, 1)));

export const monthEnd = (month) => `${month}-${pad(daysInMonth(month))}`;

// Same day-of-month in another month, clamped to that month's last day
// (31 Jan + 1 month → 28/29 Feb).
export const shiftMonths = (iso, delta) => {
  const month = addMonths(monthOf(iso), delta);
  return `${month}-${pad(Math.min(Number(iso.slice(8)), daysInMonth(month)))}`;
};

// Every month from a to b inclusive.
export const monthsBetween = (a, b) => {
  const months = [];
  for (let m = monthOf(a); m <= monthOf(b); m = addMonths(m, 1)) months.push(m);
  return months;
};

// Today's calendar date in the farm's time zone.
export const todayISO = (timeZone = FARM_TIME_ZONE) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

// ---- Formatting (English, fixed) -------------------------------------------

// Field value: 12/10/2026
export const formatDisplay = (iso) => `${iso.slice(8)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Summary: Sat 12 Oct
export const formatShort = (iso) => {
  const day = WEEKDAY_NAMES[weekdayIndex(iso)].slice(0, 3);
  return `${day} ${Number(iso.slice(8))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1].slice(0, 3)}`;
};

// Screen readers: Saturday, 12 October 2026
export const formatLong = (iso) => (
  `${WEEKDAY_NAMES[weekdayIndex(iso)]}, ${Number(iso.slice(8))} ${MONTH_NAMES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`
);

// October 2026
export const formatMonthTitle = (month) => `${MONTH_NAMES[parseMonth(month)[1] - 1]} ${month.slice(0, 4)}`;

export const nightsLabel = (n) => `${n} ${n === 1 ? 'night' : 'nights'}`;
