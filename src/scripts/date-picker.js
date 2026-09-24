// DOM controller for DatePicker.astro. Framework-agnostic and Bootstrap-free
// (nothing here imports Bootstrap; the only Bootstrap contact is listening
// for the host modal/offcanvas' own `hide.bs.*` events, §10-D). Pure rules,
// validation and placement geometry live in date-picker-logic.js so they run
// under `node --test`; every date is a 'YYYY-MM-DD' string handled through
// date-only.js (§1, §13). Section marks (§n) refer to the component spec.
//
// State machine (§4): idle → dateSelected. Selection commits immediately and
// closes the panel; there is no Apply step and no draft that outlives it.

import { addMonths, formatField, formatLong, formatMonthTitle, monthOf, shiftMonths } from './date-only.js';
import {
  buildMonthWeeks, canPageMonth, clampDate, computePlacement, dayLabel, getSingleDateState, isOutsideViewport,
  isTap, monthInWindow, moveFocusDate, normalizeAvailability, normalizeValue, resolveRules, validateDate,
} from './date-picker-logic.js';

const LABELS = {
  loading: (month) => `Loading availability for ${formatMonthTitle(month)}`,
  selected: (iso) => `${formatLong(iso)} selected`,
};

const EMPTY_MAP = new Map();
const ANNOUNCE_DELAY = 60; // §12: clear-then-set so identical repeats are still spoken
const SETTLE_DELAYS = [120, 300, 500, 700]; // §10-C: keep repositioning while the viewport settles

export class DatePicker {
  static instances = new WeakMap();

  // §11 Only one picker is open at a time.
  static openInstance = null;

  static get(el) {
    const root = el.closest('[data-dp]') ?? el;
    return DatePicker.instances.get(root) ?? new DatePicker(root);
  }

  static init(scope = document) {
    scope.querySelectorAll('[data-dp]').forEach((el) => DatePicker.get(el));
  }

  constructor(root) {
    const existing = DatePicker.instances.get(root);
    if (existing) return existing;
    DatePicker.instances.set(root, this);

    this.root = root;
    const $ = (sel) => root.querySelector(sel);
    this.field = $('[data-dp-field]');
    this.valueEl = $('[data-dp-value]');
    this.feedbackEl = $('[data-dp-feedback]');
    this.panel = $('[data-dp-panel]');
    this.titleEl = $('[data-dp-title]');
    this.prevBtn = $('[data-dp-prev]');
    this.nextBtn = $('[data-dp-next]');
    this.errorEl = $('[data-dp-error]');
    this.retryBtn = $('[data-dp-retry]');
    this.monthEl = $('[data-dp-month]');
    this.gridEl = $('[data-dp-grid]');
    this.weeksEl = $('[data-dp-weeks]');
    this.skeletonEl = $('[data-dp-skeleton]');
    this.messageEl = $('[data-dp-message]');
    this.probeEl = $('[data-dp-probe]');
    this.liveEl = $('[data-dp-live]');
    this.statusEl = $('[data-dp-status]');
    this.hiddenInput = $('[data-dp-hidden]');
    this.headerEl = $('.dp__header');
    this.host = root.closest('.modal, .offcanvas'); // §10-D

    const cfg = JSON.parse(root.dataset.config || '{}');
    this.cfg = cfg;
    this.rawRules = { minDate: cfg.minDate, maxDate: cfg.maxDate, blackoutDates: cfg.blackoutDates };
    this.rules = resolveRules(this.rawRules);

    this.value = normalizeValue(cfg.value ?? cfg.defaultValue);
    this.draft = this.value;
    this.focusDate = null;
    this.viewMonth = null;
    this.isOpen = false;
    this.disabled = Boolean(cfg.disabled);
    this.side = null; // §10 hysteresis: last chosen side of the field

    // §5 Availability: source(month) → Promise<map|rows>. `epoch` invalidates
    // everything on setSource(); `token` invalidates delayed announcements on
    // any open/close/select/source change.
    this.source = null;
    this.cache = new Map(); // month → { status: 'loading'|'ready'|'error', map }
    this.epoch = 0;
    this.token = 0;
    this.announceTimer = null;
    this.statusTimer = null;

    this.openListeners = [];
    this.settleTimers = [];
    this.raf = 0;
    this.pointerDown = null;

    this.bindEvents();
    this.updateField();
    this.setDisabled(this.disabled);

    // §9 The error prop is the only path that fires `invalid`. Deferred a
    // microtask so listeners attached right after hydration still see it.
    if (cfg.error) {
      this.setInvalid(cfg.error);
      queueMicrotask(() => this.emit('invalid', { code: 'error', reason: cfg.error }));
    }
  }

  // -- wiring ---------------------------------------------------------------

  bindEvents() {
    // §8 Tapping the field while open closes it (toggle).
    this.field.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));

    this.prevBtn.addEventListener('click', () => this.pageMonth(-1));
    this.nextBtn.addEventListener('click', () => this.pageMonth(1));
    this.retryBtn.addEventListener('click', () => this.retry());

    this.weeksEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.dp__day');
      if (btn) this.onDay(btn.dataset.date);
    });
    this.gridEl.addEventListener('keydown', (e) => this.onGridKeydown(e));

    // §8 Esc closes only the picker and returns focus to the field.
    // stopPropagation keeps a host modal from also dismissing (§10-D).
    this.root.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.isOpen) return;
      e.preventDefault();
      e.stopPropagation();
      this.close({ restoreFocus: true });
    });
  }

  // -- open / close (§8) ------------------------------------------------------

  // §8 open()
  open() {
    if (this.isOpen || this.disabled) return;
    if (DatePicker.openInstance && DatePicker.openInstance !== this) {
      DatePicker.openInstance.close({ restoreFocus: false }); // §11
    }
    DatePicker.openInstance = this;
    this.token += 1;
    this.isOpen = true;
    this.side = null;
    this.draft = this.value;
    this.clearMessage();

    this.focusDate = this.value ?? clampDate(this.rules.today, this.rules);
    this.viewMonth = monthOf(this.focusDate);
    this.ensureMonth(this.viewMonth);

    this.panel.hidden = false;
    this.field.setAttribute('aria-expanded', 'true');
    this.root.classList.add('is-open');
    this.render();
    this.position();
    if (!this.isOpen) return; // the positioner closes when the field is off-screen

    this.attachOpenListeners();
    this.focusDay(this.focusDate);
    this.settle();
    this.emit('open');
  }

  // §8 close(). `restoreFocus:false` for Tab-out, outside taps, disabling,
  // modal hide and DOM removal — the picker must never steal focus.
  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.token += 1;
    if (DatePicker.openInstance === this) DatePicker.openInstance = null;

    // §5 A response still pending for a closed picker is discarded; dropping
    // the loading entries makes the identity check in ensureMonth() fail and
    // lets the next open() fetch again.
    for (const [month, entry] of this.cache) if (entry.status === 'loading') this.cache.delete(month);

    this.detachOpenListeners();
    this.draft = this.value; // discard any uncommitted draft
    this.clearMessage();
    this.setStatus('');
    this.panel.hidden = true;
    this.panel.style.maxHeight = '';
    this.field.removeAttribute('aria-expanded');
    this.root.classList.remove('is-open');

    if (restoreFocus) this.field.focus({ preventScroll: true });
    this.emit('close');
  }

  // -- selection (§4) ----------------------------------------------------------

  // §4 onDay(iso)
  onDay(iso) {
    this.clearMessage();
    this.setFocusDate(iso, { focus: true }); // focus stays on the tapped day
    const state = this.stateOf(iso);
    const verdict = validateDate(state);
    if (state === 'disabled' || state === 'unknown') return; // §4 inert: no selection, no message, no event
    if (state === 'booked') { // §4 rejected: inline message, still no `invalid` event
      this.showMessage(verdict.reason);
      return;
    }
    this.pickDate(iso);
  }

  // §4 pickDate(iso): token → draft → repaint → announce → commit → close
  pickDate(iso) {
    this.token += 1;
    this.draft = iso;
    this.focusDate = iso;
    this.render();
    this.announce(LABELS.selected(iso));
    this.commit(iso, 'select');
    this.close({ restoreFocus: true });
  }

  commit(iso, reason) {
    this.value = iso;
    this.draft = iso;
    this.updateField();
    if (iso) this.clearInvalid();
    this.emit('change', { value: iso, reason });
  }

  // -- availability (§5) -------------------------------------------------------

  // The availability record for a day's month; null means "no source" and
  // every in-window date is available.
  availabilityFor(month) {
    if (!this.source) return null;
    return this.cache.get(month) ?? { status: 'loading', map: EMPTY_MAP };
  }

  stateOf(iso) {
    return getSingleDateState(iso, this.rules, this.availabilityFor(monthOf(iso)));
  }

  // §5 Lazy, per month, only for months intersecting [min, max]; loaded
  // months are cached. `force` re-fetches a month that errored (Retry).
  ensureMonth(month, { force = false } = {}) {
    if (!this.source || !monthInWindow(month, this.rules)) return;
    const existing = this.cache.get(month);
    if (existing && !(force && existing.status === 'error')) return;

    const epoch = this.epoch;
    const entry = { status: 'loading', map: EMPTY_MAP };
    this.cache.set(month, entry);
    if (month === this.viewMonth && this.isOpen) this.setStatus(LABELS.loading(month));

    let pending;
    try {
      pending = Promise.resolve(this.source(month));
    } catch (err) {
      pending = Promise.reject(err);
    }
    // §5 Race protection: a response only lands if this exact entry is still
    // the current one for the month and the source hasn't changed since.
    const current = () => epoch === this.epoch && this.cache.get(month) === entry;
    pending.then(
      (result) => {
        if (!current()) return;
        this.cache.set(month, { status: 'ready', map: normalizeAvailability(result) });
        this.onMonthSettled(month);
      },
      () => {
        if (!current()) return;
        this.cache.set(month, { status: 'error', map: EMPTY_MAP });
        this.onMonthSettled(month);
      },
    );
  }

  onMonthSettled(month) {
    if (!this.isOpen || month !== this.viewMonth) return;
    this.setStatus('');
    this.render();
  }

  // §5 Retry is manual only: force-load, re-announce loading, leave the
  // current selection untouched.
  retry() {
    this.token += 1;
    this.setStatus('');
    this.ensureMonth(this.viewMonth, { force: true });
    this.render();
    this.focusDay(this.focusDate);
  }

  // §5 setSource(fn): drops the cache and every in-flight response.
  setSource(fn) {
    this.source = typeof fn === 'function' ? fn : null;
    this.epoch += 1;
    this.token += 1;
    this.cache.clear();
    this.setStatus('');
    this.clearMessage();
    if (this.isOpen) {
      this.ensureMonth(this.viewMonth);
      this.render();
    }
  }

  // -- rendering (§6) ----------------------------------------------------------

  render() {
    if (!this.isOpen) return;
    const hadFocus = this.gridEl.contains(document.activeElement);
    this.titleEl.textContent = formatMonthTitle(this.viewMonth);
    this.renderNav();
    this.renderMonth();
    if (hadFocus) this.focusDay(this.focusDate, { scroll: false });
  }

  renderNav() {
    const set = (btn, delta) => {
      const blocked = !canPageMonth(this.viewMonth, delta, this.rules);
      btn.setAttribute('aria-disabled', String(blocked));
      btn.classList.toggle('disabled', blocked);
    };
    set(this.prevBtn, -1);
    set(this.nextBtn, 1);
  }

  renderMonth() {
    const entry = this.source ? this.cache.get(this.viewMonth) : null;
    const loading = entry?.status === 'loading';
    const weeks = buildMonthWeeks(this.viewMonth);

    // §6 Roving tabindex: one tab stop — the focused day, else the first
    // visible day.
    const tabDate = this.focusDate && monthOf(this.focusDate) === this.viewMonth ? this.focusDate : `${this.viewMonth}-01`;

    const frag = document.createDocumentFragment();
    for (const week of weeks) {
      const row = document.createElement('div');
      row.className = 'dp__row';
      row.setAttribute('role', 'row');
      for (const iso of week) {
        const cell = document.createElement('div');
        cell.setAttribute('role', 'gridcell');
        if (iso) {
          const state = this.stateOf(iso);
          const selected = iso === this.draft;
          const today = iso === this.rules.today;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = ['dp__day', `dp__day--${state}`, selected ? 'dp__day--selected' : '', today ? 'dp__day--today' : ''].filter(Boolean).join(' ');
          btn.dataset.date = iso;
          btn.textContent = String(Number(iso.slice(8)));
          btn.tabIndex = iso === tabDate ? 0 : -1;
          btn.setAttribute('aria-label', dayLabel(iso, { state, selected, today })); // §6
          if (state !== 'available') btn.setAttribute('aria-disabled', 'true'); // §6 not `disabled`
          if (selected) cell.setAttribute('aria-selected', 'true');
          cell.append(btn);
        } else {
          cell.className = 'dp__blank';
        }
        row.append(cell);
      }
      frag.append(row);
    }
    this.weeksEl.replaceChildren(frag);

    // §5 Loading: month not selectable, aria-busy, skeleton with the right
    // week count and no spinner. Height for six weeks is reserved in CSS.
    this.monthEl.setAttribute('aria-busy', String(loading));
    this.monthEl.classList.toggle('dp__month--loading', loading);
    this.skeletonEl.hidden = !loading;
    if (loading) {
      this.skeletonEl.replaceChildren(...weeks.map(() => {
        const row = document.createElement('div');
        row.className = 'dp__skeleton-row';
        for (let i = 0; i < 7; i += 1) {
          const cell = document.createElement('span');
          cell.className = 'placeholder dp__skeleton-cell';
          row.append(cell);
        }
        return row;
      }));
    }

    // §5 Load error: inline area in the sticky header (role=alert).
    this.errorEl.hidden = entry?.status !== 'error';
  }

  // §6/§7 Moves the roving tab stop (and optionally DOM focus) to a day,
  // switching the visible month if needed.
  setFocusDate(iso, { focus = false, scroll = true } = {}) {
    const monthChanged = monthOf(iso) !== this.viewMonth;
    this.focusDate = iso;
    if (monthChanged) {
      this.viewMonth = monthOf(iso);
      this.clearMessage();
      this.ensureMonth(this.viewMonth);
      this.render(); // re-renders the grid with the new tab stop
      this.announce(formatMonthTitle(this.viewMonth)); // §7 month changes are announced
    } else {
      this.weeksEl.querySelectorAll('.dp__day').forEach((btn) => { btn.tabIndex = btn.dataset.date === iso ? 0 : -1; });
    }
    if (focus) this.focusDay(iso, { scroll });
  }

  focusDay(iso, { scroll = true } = {}) {
    const btn = this.weeksEl.querySelector(`[data-date="${iso}"]`);
    if (!btn) return;
    btn.focus({ preventScroll: true });
    if (scroll) this.scrollDayIntoPanel(btn);
  }

  // §7 Scroll the focused day into view inside the (scrollable) panel only —
  // element.scrollIntoView() could scroll the page or a host modal too.
  scrollDayIntoPanel(btn) {
    const panelRect = this.panel.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const top = panelRect.top + this.headerEl.offsetHeight; // the sticky header covers the top edge
    if (btnRect.top < top) this.panel.scrollTop -= top - btnRect.top;
    else if (btnRect.bottom > panelRect.bottom) this.panel.scrollTop += btnRect.bottom - panelRect.bottom;
  }

  pageMonth(delta) {
    if (!canPageMonth(this.viewMonth, delta, this.rules)) return;
    this.clearMessage();
    const target = clampDate(shiftMonths(this.focusDate ?? `${this.viewMonth}-01`, delta), this.rules);
    // clamp can land back in the current month at a window edge; force the month
    this.focusDate = target;
    this.viewMonth = addMonths(this.viewMonth, delta);
    this.ensureMonth(this.viewMonth);
    this.render();
    this.announce(formatMonthTitle(this.viewMonth));
  }

  // -- keyboard (§7) -----------------------------------------------------------

  onGridKeydown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // Enter/Space select via the button's native click → onDay().
    const from = e.target.closest?.('.dp__day')?.dataset.date ?? this.focusDate;
    const target = moveFocusDate(from, e.key, this.rules);
    if (target === null) return;
    e.preventDefault();
    this.clearMessage();
    this.setFocusDate(target, { focus: true });
  }

  // -- messages & announcements (§4, §12) -------------------------------------

  showMessage(text) {
    this.messageEl.textContent = text;
    this.messageEl.classList.add('is-visible');
  }

  clearMessage() {
    this.messageEl.textContent = '';
    this.messageEl.classList.remove('is-visible');
  }

  // §12 Polite live region, cleared then re-set so a repeated identical
  // message is spoken again. Deliberately not tied to `token`: the selection
  // announcement has to survive the close() that immediately follows it.
  announce(text) {
    this.liveEl.textContent = '';
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => { this.liveEl.textContent = text; }, ANNOUNCE_DELAY);
  }

  // §12 role=status: availability loading, separate from the polite region.
  // Cleared, then set after a beat while the picker is still open.
  setStatus(text) {
    this.statusEl.textContent = '';
    clearTimeout(this.statusTimer);
    if (!text) return;
    const token = this.token;
    this.statusTimer = setTimeout(() => {
      if (this.isOpen && token === this.token) this.statusEl.textContent = text;
    }, ANNOUNCE_DELAY);
  }

  // -- field, validation display (§9) ----------------------------------------

  updateField() {
    const has = Boolean(this.value);
    this.valueEl.textContent = has ? formatField(this.value) : this.cfg.placeholder;
    this.valueEl.classList.toggle('dp__value--placeholder', !has);
    if (this.hiddenInput) this.hiddenInput.value = this.value ?? '';
    // §12 Without a visible label the button carries its own name + value.
    if (!this.cfg.hasLabel) {
      const base = this.cfg.ariaLabel || this.cfg.placeholder || 'Choose date';
      this.field.setAttribute('aria-label', has ? `${base}, ${formatLong(this.value)}` : base);
    }
  }

  describedBy(invalid) {
    const help = this.root.querySelector('.form-text')?.id;
    return [help, invalid ? this.feedbackEl.id : null].filter(Boolean).join(' ');
  }

  setInvalid(message) {
    this.feedbackEl.textContent = message;
    this.root.classList.add('is-invalid');
    this.field.classList.add('is-invalid');
    this.field.setAttribute('aria-invalid', 'true');
    this.field.setAttribute('aria-describedby', this.describedBy(true));
  }

  clearInvalid() {
    this.root.classList.remove('is-invalid');
    this.field.classList.remove('is-invalid');
    this.field.removeAttribute('aria-invalid');
    const described = this.describedBy(false);
    if (described) this.field.setAttribute('aria-describedby', described);
    else this.field.removeAttribute('aria-describedby');
  }

  // -- public API (§2, §11) -----------------------------------------------------

  getValue() {
    return this.value;
  }

  focus() {
    this.field.focus();
  }

  // §11 clear(): value → null; change fires only if a value existed. The
  // panel stays open (no visible Clear button in single mode).
  clear() {
    const had = this.value !== null;
    this.value = null;
    this.draft = null;
    this.updateField();
    if (this.isOpen) this.render();
    if (had) this.emit('change', { value: null, reason: 'clear' });
  }

  // §11 setValue(): silent (no change event); anything that isn't a real
  // date clears without throwing.
  setValue(next) {
    this.value = normalizeValue(next);
    this.draft = this.value;
    this.updateField();
    if (this.value) this.clearInvalid();
    if (this.isOpen) {
      if (this.value) {
        this.focusDate = this.value;
        this.viewMonth = monthOf(this.value);
        this.ensureMonth(this.viewMonth);
      }
      this.render();
    }
  }

  // §11 setRules({today, minDate, maxDate, blackoutDates}): recalculates the
  // window and re-clamps. A committed value the new rules rule out is cleared
  // (emitting change with reason 'rules' — the app should know).
  setRules(next = {}) {
    this.rawRules = { ...this.rawRules, ...next };
    this.rules = resolveRules(this.rawRules);
    if (this.value && getSingleDateState(this.value, this.rules, null) === 'disabled') {
      this.value = null;
      this.draft = null;
      this.updateField();
      this.emit('change', { value: null, reason: 'rules' });
    }
    if (this.focusDate) this.focusDate = clampDate(this.focusDate, this.rules);
    if (this.isOpen) {
      this.focusDate = clampDate(this.focusDate ?? this.rules.today, this.rules);
      this.viewMonth = monthOf(this.focusDate);
      this.ensureMonth(this.viewMonth);
      this.render();
      this.position();
    }
  }

  // §9 setDisabled(true): closes without restoring focus and detaches every
  // open-time listener (close() does both).
  setDisabled(next) {
    this.disabled = Boolean(next);
    this.field.disabled = this.disabled;
    this.root.classList.toggle('is-disabled', this.disabled);
    if (this.disabled) this.close({ restoreFocus: false });
  }

  destroy() {
    this.close({ restoreFocus: false });
    clearTimeout(this.announceTimer);
    clearTimeout(this.statusTimer);
    DatePicker.instances.delete(this.root);
  }

  emit(name, detail) {
    this.root.dispatchEvent(new CustomEvent(`dp:${name}`, { bubbles: true, detail }));
  }

  // -- positioning (§10) ------------------------------------------------------

  // The visual viewport in layout-viewport coordinates (position:fixed is
  // laid out against the layout viewport), or the window when unsupported.
  viewportRect() {
    const vv = window.visualViewport;
    if (vv) return { left: vv.offsetLeft, top: vv.offsetTop, right: vv.offsetLeft + vv.width, bottom: vv.offsetTop + vv.height };
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
  }

  // A fixed/sticky bar pinned to the top of the page (the site header) sits
  // above the panel's z-index, so its height is unavailable space (§10 z-order).
  // Inside a modal/offcanvas the backdrop already covers the page.
  topObstruction(viewport) {
    if (this.host) return 0;
    let bottom = 0;
    document.querySelectorAll('.fixed-top, .sticky-top, .position-fixed, [data-dp-avoid]').forEach((el) => {
      if (el.contains(this.root) || this.root.contains(el) || el.closest('.toast-container')) return;
      const position = getComputedStyle(el).position;
      if (position !== 'fixed' && position !== 'sticky') return;
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.top <= 1 && rect.bottom > 0) bottom = Math.max(bottom, rect.bottom);
    });
    return Math.max(0, bottom - viewport.top);
  }

  // §10 Measure-and-correct: park the panel at left/top 0, read where the
  // browser actually put it (a transformed/filtered ancestor — e.g. a Bootstrap
  // modal mid-animation — becomes the fixed containing block and shifts the
  // origin), then apply the delta to reach the target.
  position() {
    if (!this.isOpen) return;
    const panel = this.panel;
    panel.style.left = '0px';
    panel.style.top = '0px';
    panel.style.maxHeight = 'none';
    const origin = panel.getBoundingClientRect();
    const field = this.field.getBoundingClientRect();
    const viewport = this.viewportRect();

    // §10 Field scrolled fully out of the visual viewport → close, no focus.
    if (isOutsideViewport(field, viewport)) {
      this.close({ restoreFocus: false });
      return;
    }

    const probe = getComputedStyle(this.probeEl);
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const placement = computePlacement({
      field,
      panel: { width: origin.width, height: origin.height },
      viewport: {
        ...viewport,
        insetLeft: parseFloat(probe.paddingLeft) || 0,
        insetRight: parseFloat(probe.paddingRight) || 0,
        insetTop: this.topObstruction(viewport),
      },
      prevSide: this.side,
      margin: rem,
      edge: rem / 2,
    });
    this.side = placement.side;
    panel.style.maxHeight = placement.maxHeight === null ? '' : `${placement.maxHeight}px`;
    panel.style.left = `${placement.left - origin.left}px`;
    panel.style.top = `${placement.top - origin.top}px`;
    panel.dataset.side = placement.side;
  }

  // Coalesces bursts of scroll/resize events into one reposition per frame.
  // Repositioning never touches draft, focus or the visible month (§10).
  schedulePosition() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.position();
    });
  }

  // §10-C Keep repositioning for ~0.7s after opening: the viewport may still
  // be settling (keyboard dismissing after focus moves to a day, address bar
  // collapsing, a modal's fade transform). Hysteresis in computePlacement
  // keeps this from flip-flopping.
  settle() {
    this.settleTimers.forEach(clearTimeout);
    this.settleTimers = SETTLE_DELAYS.map((ms) => setTimeout(() => this.position(), ms));
  }

  // -- open-time listeners (§8, §10) ------------------------------------------

  listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.openListeners.push(() => target.removeEventListener(type, handler, options));
  }

  attachOpenListeners() {
    const reposition = () => this.schedulePosition();
    const vv = window.visualViewport;

    this.listen(window, 'resize', reposition);
    this.listen(window, 'orientationchange', reposition);
    if (vv) {
      this.listen(vv, 'resize', reposition);
      this.listen(vv, 'scroll', reposition);
    }
    // Any scrollable ancestor (capture: scroll doesn't bubble). A scroll that
    // starts after a pointerdown is a drag/scroll gesture, never a tap.
    this.listen(document, 'scroll', (e) => {
      this.pointerDown = null;
      if (!this.panel.contains(e.target)) reposition();
    }, { capture: true, passive: true });

    // §8 Outside tap = pointerdown + pointerup on the same outside target
    // with < ~10px travel. Never pointerdown alone.
    this.listen(document, 'pointerdown', (e) => {
      const outside = !this.root.contains(e.target);
      this.pointerDown = outside ? { target: e.target, x: e.clientX, y: e.clientY } : null;
      if (outside) this.armBackdropGuard(e.target);
    }, true);
    this.listen(document, 'pointercancel', () => { this.pointerDown = null; }, true);
    this.listen(document, 'pointerup', (e) => {
      const down = this.pointerDown;
      this.pointerDown = null;
      if (!down || !isTap(down, { target: e.target, x: e.clientX, y: e.clientY })) return;
      this.close({ restoreFocus: false }); // never steal focus from what was tapped
    }, true);

    // §8 Tab-out, or focus landing in another control (e.g. a text input),
    // closes without restoring focus.
    this.listen(document, 'focusin', (e) => {
      if (!this.root.contains(e.target)) this.close({ restoreFocus: false });
    });

    // §10-D Host modal/offcanvas starting to hide, or this picker leaving the DOM.
    if (this.host) {
      const hideEvent = this.host.classList.contains('modal') ? 'hide.bs.modal' : 'hide.bs.offcanvas';
      this.listen(this.host, hideEvent, () => this.close({ restoreFocus: false }));
    }
    const observer = new MutationObserver(() => {
      if (!this.root.isConnected) this.destroy();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    this.openListeners.push(() => observer.disconnect());
  }

  detachOpenListeners() {
    this.openListeners.forEach((off) => off());
    this.openListeners = [];
    this.settleTimers.forEach(clearTimeout);
    this.settleTimers = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.pointerDown = null;
  }

  // §10-D Decision: a tap on a Bootstrap backdrop while the picker is open
  // closes only the picker. The modal/offcanvas stays; dismissing it takes a
  // second tap. Bootstrap dismisses on the *click* that follows the tap, so
  // that one click is swallowed in the capture phase, before it reaches the
  // modal. It has to be armed at pointerdown, not pointerup: a mouse press on
  // the (focusable) .modal moves focus there, which already closes the picker
  // and detaches its listeners before pointerup ever arrives. Taps on any
  // other outside content are left alone (the tapped control still gets its
  // click).
  armBackdropGuard(target) {
    const isBackdrop = target instanceof Element
      && (target.classList.contains('modal') || target.classList.contains('modal-backdrop') || target.classList.contains('offcanvas-backdrop'));
    if (!isBackdrop) return;
    let timer;
    const disarm = () => {
      document.removeEventListener('click', swallow, true);
      document.removeEventListener('pointercancel', disarm, true);
      clearTimeout(timer);
    };
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
      disarm();
    };
    document.addEventListener('click', swallow, true);
    document.addEventListener('pointercancel', disarm, true);
    // The click follows the release; a long press gets a little grace.
    document.addEventListener('pointerup', () => { timer = setTimeout(disarm, 400); }, { capture: true, once: true });
  }
}

export const initDatePickers = (scope) => DatePicker.init(scope);
export const getDatePicker = (el) => DatePicker.get(el);
