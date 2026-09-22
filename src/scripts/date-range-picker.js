// Date range picker controller — hydrates every [data-date-range]
// rendered by DateRangePicker.astro. The booking rules are not here: they
// live in lodge-date-rules.js as pure functions on 'YYYY-MM-DD' strings, and
// this file only draws the calendar and moves the selection through them.
//
// State is kept apart on purpose:
//   the value        the hidden input, "start/end" or "" — the single source of
//                    truth (the parent owns it; setValue() re-syncs from outside)
//   draft            the selection being made while the picker is open. On
//                    desktop it is committed the moment the end is valid; on
//                    mobile only when Apply is pressed. Closing discards it.
//   phase            derived from the draft: idle → selectingEnd → rangeSelected
//   hover / preview  a valid hover range, drawn dashed; never touches the value
//   message          why the last attempt was rejected (the "invalid" state)
//   months           per-month availability: loading | ready | error
//
// The same engine also runs a single date (data-mode="single", DatePicker.astro):
// one month, the value is one 'YYYY-MM-DD' string, no nights, no preview, and the
// stay-only states (check-in-only / check-out-only) collapse to available. It has
// no footer (no summary, Apply or Clear): a tapped or clicked date commits and
// closes, on the mobile sheet too.
//
// One DOM, two presentations (same idea as Autocomplete's fullscreen): ≥ md the
// panel is a dropdown with two months; below md it is a full-screen sheet with
// one month and an Apply button. That switch is CSS plus one media query here.
//
// Public API (per element): DateRangePicker.get(el) → getValue, setValue,
// clear, open, close, setRules, setSource, setInvalid, setDisabled, focus.
// Events are bubbling CustomEvents named `date-range:<name>`: change
// { value, nights, reason } (single: { value, reason }), invalid { reason, code,
// start, end } (range only), loaderror { month, error }, open, close.
import {
  FARM_TIME_ZONE, WEEKDAY_NAMES, addDays, addMonths, formatDisplay, formatLong, formatMonthTitle,
  formatShort, isISODate, monthEnd, monthOf, monthStart, monthsBetween, shiftMonths, todayISO,
  weekdayIndex, daysInMonth,
} from './date-only.js';
import {
  calculateNights, canStartOn, formatSummary, getDateState, getSingleDateState, normalizeAvailability, thisWeekend,
  validateDate, validateRange,
} from './lodge-date-rules.js';
import { showToast } from './toast.js';
import { lockScroll, unlockScroll, inertOutside } from './dom-overlay.js';

const DESKTOP_QUERY = '(min-width: 768px)';
const HOVER_QUERY = '(hover: hover)';
const WINDOW_DAYS = 365; // default booking window: today … today + 365 days
const EDGE_GAP = 8; // px kept between the dropdown and the viewport edge
const TOAST = '.toast-container';

const LABELS = {
  loadError: "Couldn't load availability",
  retry: 'Retry',
  checking: 'Checking availability…',
  pickStart: 'Select check-in date',
  pickDate: 'Select a date',
  pickEnd: 'Select check-out',
  booked: 'That date is booked.',
  checkoutOnly: 'This date is available for check-out only.',
  sameDay: 'Check-out must be after check-in.',
  unresolvable: "Couldn't check availability for this stay. Retry loading, then try again.",
};

// What a screen reader hears after the date, per availability state.
const STATE_LABEL = {
  available: 'available',
  booked: 'booked',
  'checkin-only': 'check-in only',
  'checkout-only': 'check-out only',
  disabled: 'unavailable',
  unknown: 'availability unknown',
};
const MARKER_ICON = { 'checkin-only': 'login', 'checkout-only': 'logout' };
const NOT_SELECTABLE = new Set(['disabled', 'booked', 'unknown']);

// Same markup as Icon.astro (which can't run at runtime).
const icon = (name, size, extraClass = '') => (
  `<span class="material-symbols-outlined ${extraClass}" aria-hidden="true" style="--icon-size: ${size}px; font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' ${Math.max(size, 20)};">${name}</span>`
);

const parseValue = (raw) => {
  const match = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(raw ?? '');
  if (!match || !isISODate(match[1]) || !isISODate(match[2]) || match[1] >= match[2]) return null;
  return { start: match[1], end: match[2] };
};

const normalizeRange = (range) => (
  range && isISODate(range.start) && isISODate(range.end) && range.start < range.end
    ? { start: range.start, end: range.end }
    : null
);

const parseDate = (raw) => (isISODate(raw) ? raw : null);

const EMPTY = Object.freeze({ start: null, end: null });

// Button.astro renders a disabled button as [disabled] + .disabled + aria-disabled,
// so switching one back on has to undo all three.
const setButtonDisabled = (button, disabled) => {
  button.disabled = disabled;
  button.classList.toggle('disabled', disabled);
  if (disabled) button.setAttribute('aria-disabled', 'true');
  else button.removeAttribute('aria-disabled');
};

let uidCounter = 0;

export class DateRangePicker {
  static instances = new WeakMap();

  // Accepts the root or any element inside it (the `id` prop lands on the field).
  static get(el) {
    const root = el.closest('[data-date-range]') ?? el;
    return DateRangePicker.instances.get(root) ?? new DateRangePicker(root);
  }

  static init(scope = document) {
    scope.querySelectorAll('[data-date-range]').forEach((root) => DateRangePicker.get(root));
  }

  constructor(root) {
    this.root = root;
    DateRangePicker.instances.set(root, this);
    const cfg = JSON.parse(root.dataset.config || '{}');
    const $ = (selector) => root.querySelector(selector);

    this.uid = `dr${++uidCounter}`;
    this.field = $('.date-range__field');
    this.valueEl = $('.date-range__value');
    this.panel = $('.date-range__panel');
    this.panes = $('[data-dr-panes]');
    this.prevBtn = $('.date-range__prev');
    this.nextBtn = $('.date-range__next');
    this.closeBtn = $('.date-range__close');
    this.messageEl = $('[data-dr-message]');
    this.summaryEl = $('[data-dr-summary]');
    this.clearBtn = $('[data-dr-clear]');
    this.applyBtn = $('[data-dr-apply]');
    this.liveEl = $('[data-dr-live]');
    this.feedbackEl = $('.invalid-feedback');
    this.hidden = $('[data-dr-hidden]');

    this.mode = cfg.mode === 'single' ? 'single' : 'range';
    this.placeholder = cfg.placeholder ?? (this.mode === 'single' ? LABELS.pickDate : 'Select check-in and check-out');
    this.presets = cfg.presets ?? [];
    this.today = todayISO(FARM_TIME_ZONE);
    this.config = {
      minDate: cfg.minDate,
      maxDate: cfg.maxDate,
      minNights: cfg.minNights ?? 1,
      maxNights: cfg.maxNights,
      blackoutDates: new Set(cfg.blackoutDates ?? []),
    };
    this.ctxCache = null;

    this.source = null;
    this.availability = null; // null = no source, every in-window date is available
    this.months = new Map(); // 'YYYY-MM' → { state, token, data, error, promise }
    this.toasts = new Map(); // 'YYYY-MM' → toast handle for that month's failure

    this.isOpen = false;
    this.isSheet = false;
    this.draft = EMPTY;
    this.viewMonth = monthOf(this.today);
    this.focusDate = this.today;
    this.hoverDate = null;
    this.previewEnd = null;
    this.message = '';
    this.token = 0; // bumped by every new selection action, so a slow check can't land late
    this.releaseInert = null;
    this.externalError = '';

    this.desktopMql = window.matchMedia(DESKTOP_QUERY);
    this.hoverMql = window.matchMedia(HOVER_QUERY);

    this.messageEl.innerHTML = '';
    if (!this.hidden.value && cfg.value) this.hidden.value = this.mode === 'single' ? cfg.value : `${cfg.value.start}/${cfg.value.end}`;
    this.renderField();
    this.setDisabled(Boolean(cfg.disabled));
    if (cfg.error) this.setInvalid(cfg.error);
    this.bind();
  }

  // ---- Rules context -------------------------------------------------------

  ctx() {
    if (!this.ctxCache) {
      const c = this.config;
      this.ctxCache = {
        minDate: isISODate(c.minDate) ? c.minDate : this.today,
        maxDate: isISODate(c.maxDate) ? c.maxDate : addDays(this.today, WINDOW_DAYS),
        minNights: c.minNights,
        maxNights: c.maxNights,
        blackoutDates: c.blackoutDates,
        availability: this.source ? this.availability : null,
      };
    }
    return this.ctxCache;
  }

  get phase() {
    if (!this.draft.start) return 'idle';
    if (this.mode === 'single') return 'dateSelected';
    return this.draft.end ? 'rangeSelected' : 'selectingEnd';
  }

  get monthCount() {
    return this.mode === 'range' && this.desktopMql.matches ? 2 : 1;
  }

  // A date's state as this mode sees it.
  stateOf(iso, ctx) {
    return this.mode === 'single' ? getSingleDateState(iso, ctx) : getDateState(iso, ctx);
  }

  // The value → the draft the panel edits.
  draftFromValue() {
    const value = this.getValue();
    if (!value) return EMPTY;
    return this.mode === 'single' ? { start: value, end: null } : value;
  }

  normalize(value) {
    return this.mode === 'single' ? parseDate(value) : normalizeRange(value);
  }

  changeDetail(value, reason) {
    if (this.mode === 'single') return { value, reason };
    return { value, nights: value ? calculateNights(value.start, value.end) : 0, reason };
  }

  // Latest view month that still shows the whole window: two panes should not
  // run past maxDate when the window is wide enough not to.
  clampView(month) {
    const { minDate, maxDate } = this.ctx();
    const lowest = monthOf(minDate);
    const highest = addMonths(monthOf(maxDate), -(this.monthCount - 1));
    const upper = highest < lowest ? lowest : highest;
    if (month < lowest) return lowest;
    return month > upper ? upper : month;
  }

  clampDate(iso) {
    const first = monthStart(monthOf(this.ctx().minDate));
    const last = monthEnd(monthOf(this.ctx().maxDate));
    if (iso < first) return first;
    return iso > last ? last : iso;
  }

  // ---- Public API ----------------------------------------------------------

  // Range: { start, end } | null. Single: 'YYYY-MM-DD' | null.
  getValue() {
    return this.mode === 'single' ? parseDate(this.hidden.value) : parseValue(this.hidden.value);
  }

  // The parent is authoritative: this mirrors a value set from outside and
  // never fires `change`.
  setValue(value) {
    this.writeValue(this.normalize(value));
    if (this.isOpen) {
      this.draft = this.draftFromValue();
      this.previewEnd = null;
      this.paint();
      this.paintFooter();
    }
  }

  clear() {
    const had = this.getValue();
    this.token += 1;
    this.draft = EMPTY;
    this.previewEnd = null;
    this.clearMessage();
    this.writeValue(null);
    if (had) this.emit('change', this.changeDetail(null, 'clear'));
    if (this.isOpen) {
      this.paint();
      this.paintFooter();
      this.focusCell(this.focusDate);
    }
  }

  // Function-valued rules (minNights/maxNights of the start date) can't travel
  // through data attributes, so they arrive here.
  setRules(rules = {}) {
    const { today, blackoutDates, ...rest } = rules;
    if (isISODate(today)) this.today = today;
    Object.assign(this.config, rest);
    if (blackoutDates) this.config.blackoutDates = new Set(blackoutDates);
    this.ctxCache = null;
    if (this.isOpen) {
      this.viewMonth = this.clampView(this.viewMonth);
      this.renderMonths();
      this.paintFooter();
    }
  }

  // fn(month: 'YYYY-MM') → Promise of a map or of { date, status } rows. The
  // component knows nothing about the backend; normalizeAvailability adapts it.
  setSource(fn) {
    this.source = typeof fn === 'function' ? fn : null;
    this.months.clear();
    this.toasts.forEach((toast) => toast.hide());
    this.toasts.clear();
    this.availability = this.source ? {} : null;
    this.ctxCache = null;
    if (this.isOpen) {
      this.renderMonths();
      this.paintFooter();
    }
  }

  setDisabled(disabled) {
    this.field.disabled = disabled;
    this.root.classList.toggle('is-disabled', disabled);
    if (disabled) this.close({ restoreFocus: false });
  }

  setInvalid(message) {
    this.externalError = message || '';
    const invalid = Boolean(this.externalError);
    this.field.classList.toggle('is-invalid', invalid);
    this.root.classList.toggle('is-invalid', invalid);
    this.field.setAttribute('aria-invalid', String(invalid));
    this.feedbackEl.textContent = this.externalError;
    const ids = new Set((this.field.dataset.describedby || '').split(' ').filter(Boolean));
    if (invalid) ids.add(this.feedbackEl.id);
    if (ids.size) this.field.setAttribute('aria-describedby', [...ids].join(' '));
    else this.field.removeAttribute('aria-describedby');
  }

  focus() {
    this.field.focus();
  }

  // ---- Events --------------------------------------------------------------

  emit(name, detail = {}) {
    this.root.dispatchEvent(new CustomEvent(`date-range:${name}`, { bubbles: true, detail }));
  }

  announce(text) {
    clearTimeout(this.liveTimer);
    this.liveEl.textContent = '';
    this.liveTimer = setTimeout(() => { this.liveEl.textContent = text; }, 120);
  }

  bind() {
    this.field.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    this.closeBtn.addEventListener('click', () => this.close());
    this.prevBtn.addEventListener('click', () => this.navigate(-1));
    this.nextBtn.addEventListener('click', () => this.navigate(1));
    // The footer (summary, Clear, Apply) only exists in range mode.
    this.clearBtn?.addEventListener('click', () => this.clear());
    this.applyBtn?.addEventListener('click', () => this.apply());
    this.root.querySelectorAll('[data-dr-preset]').forEach((button) => {
      button.addEventListener('click', () => this.applyPreset(Number(button.dataset.drPreset)));
    });

    this.panes.addEventListener('click', (e) => {
      const day = e.target.closest('[data-dr-day]');
      if (day) this.onDay(day.dataset.drDay);
      const retry = e.target.closest('[data-dr-retry]');
      if (retry) this.retry(retry.dataset.drRetry);
    });
    // On the panel, not the grid: while a month is loading focus waits on the panel itself.
    this.panel.addEventListener('keydown', (e) => this.onGridKey(e));
    this.panes.addEventListener('mouseover', (e) => {
      if (!this.hoverMql.matches) return;
      this.setPreview(e.target.closest('[data-dr-day]')?.dataset.drDay ?? null);
    });
    this.panes.addEventListener('mouseleave', () => this.setPreview(null));

    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.close();
    });
    // Desktop: tabbing out of the open dropdown closes it (focus is not restored,
    // it is already going somewhere on purpose).
    this.root.addEventListener('focusout', (e) => {
      const to = e.relatedTarget;
      if (this.isOpen && !this.isSheet && to && !this.root.contains(to) && !to.closest?.(TOAST)) {
        this.close({ restoreFocus: false });
      }
    });

    this.onOutside = (e) => {
      // A toast (the availability error's Retry) belongs to this flow.
      if (this.root.contains(e.target) || e.target.closest?.(TOAST)) return;
      const hadFocus = this.root.contains(document.activeElement);
      this.close({ restoreFocus: false });
      // Focus only comes back if nothing else claimed it (clicking another
      // control moves focus there, which we must not steal).
      if (hadFocus) requestAnimationFrame(() => { if (document.activeElement === document.body) this.field.focus(); });
    };
    this.onPresentationChange = () => {
      if (!this.isOpen) return;
      this.applyPresentation();
      this.viewMonth = this.clampView(this.viewMonth);
      this.renderMonths();
    };
    this.desktopMql.addEventListener('change', this.onPresentationChange);
  }

  // ---- Open / close --------------------------------------------------------

  open() {
    if (this.isOpen || this.field.disabled) return;
    this.isOpen = true;
    this.token += 1;
    this.draft = this.draftFromValue();
    this.previewEnd = null;
    this.hoverDate = null;
    this.clearMessage();

    this.focusDate = this.clampDate(this.draft.start ?? this.today);
    this.viewMonth = this.clampView(monthOf(this.focusDate));

    this.panel.hidden = false;
    this.panel.classList.add('show');
    this.root.classList.add('is-open');
    this.field.setAttribute('aria-expanded', 'true');
    this.applyPresentation();
    this.renderMonths({ restoreFocus: true });
    this.paintFooter();
    document.addEventListener('pointerdown', this.onOutside, true);
    this.emit('open');
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.token += 1;
    this.panel.hidden = true;
    this.panel.classList.remove('show', 'is-end');
    this.root.classList.remove('is-open');
    this.field.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onOutside, true);
    this.releaseOverlay();
    this.draft = EMPTY;
    this.previewEnd = null;
    this.hoverDate = null;
    this.clearMessage();
    if (restoreFocus) this.field.focus();
    this.emit('close');
  }

  // Sheet (fullscreen, modal) below md; dropdown from md up.
  applyPresentation() {
    this.isSheet = !this.desktopMql.matches;
    this.releaseOverlay();
    if (this.isSheet) {
      this.panel.setAttribute('aria-modal', 'true');
      this.releaseInert = inertOutside(this.panel);
      lockScroll();
      this.locked = true;
    } else {
      this.panel.removeAttribute('aria-modal');
      this.alignPanel();
    }
  }

  releaseOverlay() {
    this.releaseInert?.();
    this.releaseInert = null;
    if (this.locked) unlockScroll();
    this.locked = false;
  }

  // Open towards the right if the dropdown would run off the viewport edge.
  alignPanel() {
    this.panel.classList.remove('is-end');
    const { right } = this.panel.getBoundingClientRect();
    if (right > document.documentElement.clientWidth - EDGE_GAP) this.panel.classList.add('is-end');
  }

  // ---- Availability loading ------------------------------------------------

  // Only months that intersect the booking window ask for availability.
  needsData(month) {
    const { minDate, maxDate } = this.ctx();
    return Boolean(this.source) && month >= monthOf(minDate) && month <= monthOf(maxDate);
  }

  // Loads once and caches; an errored month is not retried here, only by retry().
  load(month, { force = false } = {}) {
    const current = this.months.get(month);
    if (current && !force) return current.promise;
    const entry = { state: 'loading', token: (current?.token ?? 0) + 1, data: null, error: null };
    this.months.set(month, entry);
    entry.promise = this.fetchMonth(month, entry);
    return entry.promise;
  }

  async fetchMonth(month, entry) {
    try {
      const raw = await this.source(month);
      if (this.months.get(month) !== entry) return;
      entry.data = normalizeAvailability(raw);
      entry.state = 'ready';
      this.hideToast(month);
    } catch (error) {
      if (this.months.get(month) !== entry) return;
      entry.state = 'error';
      entry.error = error;
      this.emit('loaderror', { month, error });
      this.showErrorToast(month);
    }
    this.availability = Object.assign({}, ...[...this.months.values()].filter((m) => m.state === 'ready').map((m) => m.data));
    this.ctxCache = null;
    if (this.isOpen) {
      this.renderMonths();
      this.paintFooter();
    }
  }

  // Inline Retry and the toast's Retry both land here. The selection is not
  // touched: only that month's availability is asked for again.
  retry(month) {
    if (!this.source) return;
    this.hideToast(month);
    this.load(month, { force: true });
    this.announce(`Loading availability for ${formatMonthTitle(month)}`);
    if (this.isOpen) this.renderMonths();
  }

  showErrorToast(month) {
    if (this.toasts.has(month)) return; // one failure, one toast
    const handle = showToast({
      body: LABELS.loadError,
      theme: 'error',
      autoHide: false,
      action: { label: LABELS.retry, onClick: () => this.retry(month) },
      onClose: () => { if (this.toasts.get(month) === handle) this.toasts.delete(month); },
    });
    if (handle) this.toasts.set(month, handle);
  }

  hideToast(month) {
    this.toasts.get(month)?.hide();
    this.toasts.delete(month);
  }

  // ---- Rendering -----------------------------------------------------------

  renderMonths({ restoreFocus } = {}) {
    const months = Array.from({ length: this.monthCount }, (_, i) => addMonths(this.viewMonth, i));
    months.forEach((month) => { if (this.needsData(month)) this.load(month); });

    const active = document.activeElement;
    const hadFocus = restoreFocus ?? (this.panes.contains(active) || active === this.panel);
    const ctx = this.ctx();
    this.panes.innerHTML = months.map((month) => this.paneHTML(month, ctx)).join('');
    this.panes.dataset.count = String(months.length);

    const failed = months.some((m) => this.months.get(m)?.state === 'error');
    const loading = months.some((m) => this.months.get(m)?.state === 'loading');
    this.root.dataset.state = failed ? 'error' : (loading ? 'loading' : 'ready');

    this.updateNav();
    this.paint();
    if (hadFocus) this.focusCell(this.focusDate);
  }

  paneHTML(month, ctx) {
    const entry = this.months.get(month);
    const titleId = `${this.uid}-${month}`;
    const title = formatMonthTitle(month);
    const lead = weekdayIndex(monthStart(month));
    const days = daysInMonth(month);
    const rows = Math.ceil((lead + days) / 7);

    const heading = `<h3 class="date-range__month h6" id="${titleId}">${title}</h3>`;
    const weekdays = WEEKDAY_NAMES.map((name) => (
      `<div role="columnheader" class="date-range__weekday"><span aria-hidden="true">${name.slice(0, 2)}</span><span class="visually-hidden">${name}</span></div>`
    )).join('');

    if (entry?.state === 'loading') {
      const cells = Array.from({ length: rows * 7 }, () => '<div class="date-range__skeleton-cell"><span class="placeholder"></span></div>').join('');
      return `<div class="date-range__pane" aria-busy="true">${heading}
        <p class="visually-hidden" role="status">Loading availability for ${title}</p>
        <div class="date-range__grid placeholder-glow" aria-hidden="true"><div class="date-range__row">${weekdays}</div><div class="date-range__skeleton">${cells}</div></div>
      </div>`;
    }

    const cells = [
      ...Array.from({ length: lead }, () => '<div role="gridcell" class="date-range__blank" aria-hidden="true"></div>'),
      ...Array.from({ length: days }, (_, i) => this.cellHTML(`${month}-${String(i + 1).padStart(2, '0')}`, ctx)),
    ];
    while (cells.length % 7) cells.push('<div role="gridcell" class="date-range__blank" aria-hidden="true"></div>');
    const body = Array.from({ length: rows }, (_, r) => `<div role="row" class="date-range__row">${cells.slice(r * 7, r * 7 + 7).join('')}</div>`).join('');

    const error = entry?.state === 'error'
      ? `<div class="date-range__error" role="alert">${icon('error', 20)}<span>${LABELS.loadError}</span><button type="button" class="btn btn-outline-primary btn-sm" data-dr-retry="${month}">${LABELS.retry}</button></div>`
      : '';
    return `<div class="date-range__pane">${heading}${error}
      <div role="grid" class="date-range__grid" aria-labelledby="${titleId}"><div role="row" class="date-range__row">${weekdays}</div>${body}</div>
    </div>`;
  }

  // Everything that depends on availability is fixed here; selection-dependent
  // classes and labels are applied by paint().
  cellHTML(iso, ctx) {
    const state = this.stateOf(iso, ctx);
    const marker = MARKER_ICON[state] ? icon(MARKER_ICON[state], 14, 'date-range__marker') : '';
    const classes = ['date-range__day', `is-${state}`, iso === this.today ? 'is-today' : ''].filter(Boolean).join(' ');
    return `<div role="gridcell" class="date-range__cell" data-cell="${iso}"><button type="button" class="${classes}" data-dr-day="${iso}" tabindex="-1"${NOT_SELECTABLE.has(state) ? ' aria-disabled="true"' : ''}><span class="date-range__num">${Number(iso.slice(8))}</span>${marker}</button></div>`;
  }

  // Selection-dependent state: band, selected fill, accessible name, roving tabindex.
  paint() {
    const ctx = this.ctx();
    const { start, end } = this.draft;
    const preview = this.previewEnd;
    this.root.dataset.phase = this.phase;

    this.panes.querySelectorAll('[data-cell]').forEach((cell) => {
      const iso = cell.dataset.cell;
      const button = cell.firstElementChild;
      const state = this.stateOf(iso, ctx);
      const isStart = iso === start;
      const isEnd = iso === end;
      const inRange = Boolean(start && end && iso > start && iso < end);

      let band = '';
      if (start && end) {
        if (isStart) band = 'range-start';
        else if (isEnd) band = 'range-end';
        else if (inRange) band = 'range-mid';
      } else if (start && preview) {
        if (isStart) band = 'preview-start';
        else if (iso === preview) band = 'preview-end';
        else if (iso > start && iso < preview) band = 'preview-mid';
      }
      cell.className = `date-range__cell${band ? ` is-${band}` : ''}`;
      cell.setAttribute('aria-selected', String(isStart || isEnd || inRange));
      button.classList.toggle('is-selected', isStart || isEnd);

      const parts = [];
      if (iso === this.today) parts.push('today');
      if (isStart) parts.push(this.mode === 'single' ? 'selected' : 'selected as check-in');
      else if (isEnd) parts.push('selected as check-out');
      else if (inRange) parts.push('in your stay');
      // Single date: a taken date is just "unavailable", never "booked".
      parts.push(this.mode === 'single' && state === 'booked' ? STATE_LABEL.disabled : STATE_LABEL[state]);
      button.setAttribute('aria-label', `${formatLong(iso)}, ${parts.join(', ')}`);
      button.tabIndex = iso === this.focusDate ? 0 : -1;
    });

    // The roving stop must exist: if the focus date is not on screen, use the first day.
    if (!this.panes.querySelector('[tabindex="0"]')) {
      const first = this.panes.querySelector('[data-dr-day]');
      if (first) first.tabIndex = 0;
    }
  }

  paintFooter() {
    if (!this.summaryEl) return; // single date: no footer
    const { start, end } = this.draft;
    let text = LABELS.pickStart;
    if (end) text = formatSummary(start, end);
    else if (start) text = `${formatShort(start)} → ${LABELS.pickEnd}`;
    this.summaryEl.textContent = text;
    setButtonDisabled(this.applyBtn, !end);
    setButtonDisabled(this.clearBtn, !(this.getValue() || start));
  }

  updateNav() {
    const { minDate } = this.ctx();
    const atStart = this.viewMonth <= monthOf(minDate);
    const atEnd = this.clampView(addMonths(this.viewMonth, 1)) === this.viewMonth;
    [[this.prevBtn, atStart], [this.nextBtn, atEnd]].forEach(([button, off]) => {
      // aria-disabled (not `disabled`) so a focused arrow keeps focus at the edge.
      button.setAttribute('aria-disabled', String(off));
      button.classList.toggle('disabled', off);
    });
  }

  renderField() {
    const value = this.getValue();
    this.valueEl.classList.toggle('is-placeholder', !value);
    if (value && this.mode === 'single') {
      this.valueEl.textContent = formatDisplay(value);
    } else if (value) {
      this.valueEl.innerHTML = `${formatDisplay(value.start)} <span aria-hidden="true">→</span><span class="visually-hidden">to</span> ${formatDisplay(value.end)}`;
    } else {
      this.valueEl.textContent = this.placeholder;
    }
  }

  writeValue(value) {
    if (!value) this.hidden.value = '';
    else this.hidden.value = this.mode === 'single' ? value : `${value.start}/${value.end}`;
    this.renderField();
  }

  showMessage(text) {
    this.message = text;
    this.messageEl.replaceChildren();
    const span = document.createElement('span');
    span.textContent = text;
    this.messageEl.insertAdjacentHTML('afterbegin', icon('error', 20));
    this.messageEl.append(span);
  }

  clearMessage() {
    this.message = '';
    this.messageEl.replaceChildren();
  }

  // ---- Navigation & keyboard ----------------------------------------------

  navigate(delta) {
    const view = this.clampView(addMonths(this.viewMonth, delta));
    if (view === this.viewMonth) return;
    this.viewMonth = view;
    this.focusDate = this.clampDate(shiftMonths(this.focusDate, delta));
    this.previewEnd = null;
    this.clearMessage();
    this.renderMonths({ restoreFocus: false });
    const shown = Array.from({ length: this.monthCount }, (_, i) => formatMonthTitle(addMonths(view, i)));
    this.announce(shown.join(' and '));
  }

  focusCell(iso) {
    const button = this.panes.querySelector(`[data-dr-day="${iso}"]`);
    (button ?? this.panel).focus();
  }

  moveFocus(target) {
    const date = this.clampDate(target);
    const count = this.monthCount;
    let view = this.viewMonth;
    if (monthOf(date) < view) view = monthOf(date);
    else if (monthOf(date) > addMonths(view, count - 1)) view = addMonths(monthOf(date), -(count - 1));
    view = this.clampView(view);

    this.focusDate = date;
    if (this.phase === 'selectingEnd') this.previewEnd = this.previewFor(date);
    if (view !== this.viewMonth) {
      this.viewMonth = view;
      this.renderMonths({ restoreFocus: true });
      this.announce(Array.from({ length: count }, (_, i) => formatMonthTitle(addMonths(view, i))).join(' and '));
    } else {
      this.paint();
      this.focusCell(date);
    }
  }

  // Arrow keys, Home/End (week), PageUp/PageDown (month). Enter and Space are
  // the button's own click, so they go through onDay() like a mouse press.
  onGridKey(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const day = e.target.closest?.('[data-dr-day]');
    const iso = day ? day.dataset.drDay : (e.target === this.panel ? this.focusDate : null);
    if (!iso) return;
    const targets = {
      ArrowLeft: () => addDays(iso, -1),
      ArrowRight: () => addDays(iso, 1),
      ArrowUp: () => addDays(iso, -7),
      ArrowDown: () => addDays(iso, 7),
      Home: () => addDays(iso, -weekdayIndex(iso)),
      End: () => addDays(iso, 6 - weekdayIndex(iso)),
      PageUp: () => shiftMonths(iso, -1),
      PageDown: () => shiftMonths(iso, 1),
    };
    if (!targets[e.key]) return;
    e.preventDefault();
    this.moveFocus(targets[e.key]());
  }

  // ---- Selection -----------------------------------------------------------

  onDay(iso) {
    this.focusDate = iso;
    this.previewEnd = null;
    if (this.mode === 'single') {
      this.pickDate(iso);
      return;
    }
    const state = getDateState(iso, this.ctx());

    // Past, outside the window, blackout and not-yet-loaded dates are inert.
    // A booked date says so, so a click never fails silently.
    if (state === 'disabled' || state === 'unknown') {
      this.paint();
      this.focusCell(iso);
      return;
    }
    if (state === 'booked') {
      this.reject({ reason: LABELS.booked, code: 'date-booked' }, { emit: false });
      return;
    }

    const { start } = this.draft;
    if (this.phase !== 'selectingEnd' || iso < start) {
      this.startAt(iso);
    } else if (iso === start) {
      this.reject({ reason: LABELS.sameDay, code: 'same-day', start, end: iso });
    } else {
      this.finishAt(iso);
    }
  }

  // Single date: one click picks it, commits and closes (desktop and sheet alike,
  // there is no Apply). Unavailable and not-yet-loaded dates are inert; a taken
  // one says so.
  pickDate(iso) {
    const result = validateDate(iso, this.ctx());
    if (!result.ok) {
      if (result.code === 'date-booked') {
        this.reject(result, { emit: false });
      } else {
        this.paint();
        this.focusCell(iso);
      }
      return;
    }
    this.token += 1;
    this.draft = { start: iso, end: null };
    this.clearMessage();
    this.paint();
    this.announce(`${formatLong(iso)} selected`);
    this.commit(iso);
    this.close();
  }

  // Check-in. A date earlier than the current start replaces it, the same way.
  startAt(iso) {
    if (!canStartOn(getDateState(iso, this.ctx()))) {
      this.reject({ reason: LABELS.checkoutOnly, code: 'start-checkout-only' }, { emit: false });
      return;
    }
    this.token += 1;
    this.draft = { start: iso, end: null };
    this.clearMessage();
    this.paint();
    this.paintFooter();
    this.focusCell(iso);
    this.announce(`Check-in ${formatLong(iso)}. Choose a check-out date.`);
  }

  // Check-out. Availability for every month the stay crosses must be known
  // before the rules can judge it, so anything not loaded yet is fetched first.
  async finishAt(end) {
    const start = this.draft.start;
    const token = ++this.token;
    const result = await this.checkRange(start, end, token);
    if (!result) return; // superseded, or the picker closed
    if (!result.ok) {
      this.reject({ ...result, start, end });
      return;
    }
    this.draft = { start, end };
    this.previewEnd = null;
    this.clearMessage();
    this.paint();
    this.paintFooter();
    this.announce(formatSummary(start, end));
    if (this.isSheet) return; // mobile: wait for Apply
    this.commit(this.draft);
    this.close();
  }

  async checkRange(start, end, token) {
    const pending = monthsBetween(start, end)
      .filter((m) => this.needsData(m) && !['ready', 'error'].includes(this.months.get(m)?.state))
      .map((m) => this.load(m));
    if (pending.length) {
      this.summaryEl.textContent = LABELS.checking;
      setButtonDisabled(this.applyBtn, true);
      this.announce(LABELS.checking);
      await Promise.all(pending);
    }
    if (token !== this.token || !this.isOpen) return null;
    const result = validateRange(start, end, this.ctx());
    if (!result.ok && result.code === 'unknown' && monthsBetween(start, end).some((m) => this.months.get(m)?.state === 'error')) {
      return { ...result, reason: LABELS.unresolvable };
    }
    return result;
  }

  async applyPreset(index) {
    const preset = this.presets[index];
    const range = preset?.range === 'this-weekend' ? thisWeekend(this.today) : normalizeRange(preset?.range);
    if (!range) return;
    const token = ++this.token;
    const result = await this.checkRange(range.start, range.end, token);
    if (!result) return;
    if (!result.ok) {
      this.reject({ ...result, start: range.start, end: range.end });
      return;
    }
    this.draft = range;
    this.clearMessage();
    this.focusDate = range.start;
    this.viewMonth = this.clampView(monthOf(range.start));
    this.renderMonths({ restoreFocus: true });
    this.paintFooter();
    this.announce(formatSummary(range.start, range.end));
    if (this.isSheet) return;
    this.commit(range);
    this.close();
  }

  // Mobile: the sheet's Apply button.
  apply() {
    if (!this.draft.end) return;
    this.commit(this.draft);
    this.close();
  }

  // `value` is a range ({ start, end }) or, in single mode, a date string.
  commit(value) {
    const previous = this.getValue();
    this.writeValue(value);
    const same = this.mode === 'single'
      ? previous === value
      : previous?.start === value.start && previous?.end === value.end;
    if (same) return;
    this.emit('change', this.changeDetail(this.mode === 'single' ? value : { start: value.start, end: value.end }, 'select'));
  }

  // An attempt that must not be committed: say why, and keep the selection.
  reject({ reason, code, start, end }, { emit = true } = {}) {
    this.showMessage(reason);
    this.paint();
    this.paintFooter();
    this.focusCell(this.focusDate);
    if (emit) this.emit('invalid', { reason, code, start, end });
  }

  // ---- Hover / focus preview ----------------------------------------------

  // The end date a preview may show: only a range that would be accepted. A
  // single date has no end, and its saved date sits in `draft.start`, so it must
  // never look like a range in progress.
  previewFor(iso) {
    if (this.mode === 'single') return null;
    const { start, end } = this.draft;
    if (!start || end || !iso || iso <= start) return null;
    return validateRange(start, iso, this.ctx()).ok ? iso : null;
  }

  setPreview(iso) {
    this.hoverDate = iso;
    const next = this.previewFor(iso);
    if (next === this.previewEnd) return;
    this.previewEnd = next;
    this.paint();
  }
}

export const initDateRangePickers = (scope) => DateRangePicker.init(scope);
export const getDateRangePicker = (el) => DateRangePicker.get(el);
