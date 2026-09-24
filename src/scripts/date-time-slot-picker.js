// Date & Time Slot Picker controller — hydrates every [data-dtsp] rendered
// by DateTimeSlotPicker.astro. Two presentations share this one controller:
// `inline` drives a bootstrap.Collapse embedded in its own container,
// `modal` drives a bootstrap.Modal the component owns. Neither uses
// data-bs-toggle: opening is always unguarded, but *closing* has to be
// interceptable (the recorded prototype blocks the close/apply gesture
// entirely when nothing is selected), which Bootstrap's declarative
// attribute API can't do — so both are driven imperatively via
// bootstrap.Collapse/Modal.getOrCreateInstance(), per the component's own
// tech constraint that this stay "vanilla JS driving Bootstrap's ...
// instances", not a reimplementation of them.
//
// Pure date/format/payload helpers live in date-time-slot-picker-logic.js
// (covered by date-time-slot-picker.test.js) — this file is the DOM layer
// on top of them.
//
// Public API (per element): DateTimeSlotPicker.get(el) → instance with
// open, close, apply, cancel, clear, setValue, getValue, setAvailability,
// setSlotsState, setDateDisabledRule, setDisabled, setLoading. Callbacks
// can't be props on a build-time component, so every onX in the spec is a
// bubbling DOM CustomEvent named `dtsp:<name>` instead (see emit()).
//
// `isDateDisabled` is a function — it can't survive server rendering as a
// prop either, so it isn't one: call setDateDisabledRule(fn) after
// hydration. Because that can happen *after* this script has already
// resolved the initial default date from disabledDates + min/max alone,
// setDateDisabledRule re-resolves the draft date against the new rule (and
// re-renders) if it invalidates what's currently showing.

import { Collapse, Modal } from 'bootstrap';
import {
  PERIODS,
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
  todayISO,
} from './date-time-slot-picker-logic.js';

const DEFAULTS = {
  presentation: 'modal',
  minDate: 'today',
  maxDate: '+30days',
  initialDate: undefined,
  dateFormat: 'ddd, MMM D',
  disabledDates: [],
  timeFormat: '12h',
  showPeriodGroups: true,
  showPeriodTimeRange: true,
  value: null,
  defaultValue: null,
  requireConfirmation: true,
  resetTimeOnDateChange: true,
  triggerLabel: 'Select Date & Time',
  triggerDescription: 'Choose an available slot',
  closeOnEscape: true,
  closeOnOutsideClick: false,
  required: false,
  disabled: false,
  loading: false,
  availability: [],
};

const LABELS = {
  requiredInline: 'Please select a time slot.',
  requiredModal: 'Please select a time slot to continue.',
  empty: 'No available times for this date. Please choose another date.',
  error: 'Unable to load available times.',
  clickToModify: 'Click to modify selection',
};

// ---------------------------------------------------------------------------
// DOM controller
// ---------------------------------------------------------------------------

export class DateTimeSlotPicker {
  static instances = new WeakMap();

  static get(el) {
    const root = el.closest('[data-dtsp]') ?? el;
    return DateTimeSlotPicker.instances.get(root) ?? new DateTimeSlotPicker(root);
  }

  static init(scope = document) {
    scope.querySelectorAll('[data-dtsp]').forEach((el) => DateTimeSlotPicker.get(el));
  }

  constructor(root) {
    const existing = DateTimeSlotPicker.instances.get(root);
    if (existing) return existing;
    DateTimeSlotPicker.instances.set(root, this);

    this.root = root;
    const $ = (sel) => root.querySelector(sel);
    this.field = $('.dtsp__field');
    this.triggerEl = $('[data-dtsp-trigger]');
    this.triggerPrimaryEl = $('[data-dtsp-trigger-primary]');
    this.triggerSecondaryEl = $('[data-dtsp-trigger-secondary]');
    this.feedbackEl = $('[data-dtsp-feedback]');
    this.panelEl = $('.dtsp__panel') || $('.dtsp__modal');
    this.dateStripEl = $('[data-dtsp-date-strip]');
    this.prevBtn = $('[data-dtsp-prev]');
    this.nextBtn = $('[data-dtsp-next]');
    this.groupsEl = $('[data-dtsp-groups]');
    this.validationEl = $('[data-dtsp-validation]');
    this.validationTextEl = $('[data-dtsp-validation-text]');
    this.liveEl = $('[data-dtsp-live]');
    this.hiddenInput = $('[data-dtsp-hidden-input]');
    this.applyBtn = $('[data-dtsp-apply]');
    this.cancelBtns = [...root.querySelectorAll('[data-dtsp-cancel]')];

    const cfg = JSON.parse(root.dataset.config || '{}');
    this.cfg = { ...DEFAULTS, ...cfg };
    this.presentation = this.cfg.presentation;
    this.inline = this.presentation === 'inline';

    this.min = resolveWindowBound(this.cfg.minDate);
    this.max = resolveWindowBound(this.cfg.maxDate);
    this.disabledSet = new Set(this.cfg.disabledDates);
    this.dateDisabledRule = null;

    this.availabilityMap = new Map();
    this.setAvailability(this.cfg.availability, { silent: true });
    this.slotsState = 'ready'; // 'ready' | 'loading' | 'empty' | 'error'

    this.committed = this.cfg.value ?? this.cfg.defaultValue ?? null;
    this.defaultActiveDate = resolveDefaultDate({
      initialDate: this.cfg.initialDate,
      min: this.min,
      max: this.max,
      disabledSet: this.disabledSet,
      rule: this.dateDisabledRule,
      warn: (msg) => console.warn(msg),
    });
    this.draftDate = this.committed?.value?.date ?? this.defaultActiveDate;
    this.draftSlotId = this.committed?.slot?.id ?? null;
    this.draftGroup = this.committed?.slot?.group ?? null;

    this.isOpen = false;
    this.pendingApply = false;

    if (this.groupsEl) {
      this.groupsEl.setAttribute('role', 'listbox');
      this.groupsEl.setAttribute('aria-label', 'Time slots');
    }

    this.bindEvents();
    this.updateTriggerDisplay();
    this.setDisabled(this.cfg.disabled);
    if (this.cfg.loading) this.setLoading(true);
  }

  // -- wiring ---------------------------------------------------------------

  bindEvents() {
    this.triggerEl?.addEventListener('click', () => this.onTriggerClick());
    this.prevBtn?.addEventListener('click', () => this.pageDateStrip(-1));
    this.nextBtn?.addEventListener('click', () => this.pageDateStrip(1));

    this.dateStripEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('.dtsp__date-item');
      if (!btn || btn.disabled) return;
      this.selectDate(btn.dataset.date);
    });
    this.dateStripEl?.addEventListener('keydown', (e) => this.onDateStripKeydown(e));

    this.groupsEl?.addEventListener('click', (e) => {
      const btn = e.target.closest('.dtsp__slot');
      if (!btn || btn.disabled) return;
      this.selectSlot(btn.dataset.slotId, btn.dataset.time, btn.dataset.group);
    });
    this.groupsEl?.addEventListener('keydown', (e) => this.onGroupsKeydown(e));

    // The real interactive control is the trigger <button> — a value-only
    // `type="hidden"` input carries the name/value pair for a native form
    // POST but is excluded from constraint validation entirely (hidden
    // inputs never have willValidate), so "required" is enforced on submit
    // here instead, mirroring Autocomplete's own validate()/showValidity().
    this.form = this.root.closest('form');
    this.form?.addEventListener('submit', (e) => this.handleFormSubmit(e));

    if (this.inline && this.panelEl) {
      this.panelEl.addEventListener('show.bs.collapse', () => {
        this.resetDraftToCommitted();
        this.renderDateStrip();
        this.renderGroups();
        this.hideValidation();
      });
      this.panelEl.addEventListener('shown.bs.collapse', () => {
        this.isOpen = true;
        this.triggerEl?.setAttribute('aria-expanded', 'true');
        this.emit('open');
      });
      this.panelEl.addEventListener('hidden.bs.collapse', () => {
        this.isOpen = false;
        this.triggerEl?.setAttribute('aria-expanded', 'false');
        this.emit('close');
      });
    }

    if (!this.inline && this.panelEl) {
      this.panelEl.addEventListener('show.bs.modal', () => {
        this.pendingApply = false;
        this.resetDraftToCommitted();
        this.renderDateStrip();
        this.renderGroups();
        this.hideValidation();
      });
      this.panelEl.addEventListener('shown.bs.modal', () => {
        this.isOpen = true;
        this.emit('open');
      });
      this.panelEl.addEventListener('hidden.bs.modal', () => {
        this.isOpen = false;
        if (!this.pendingApply) {
          this.resetDraftToCommitted();
          this.emit('cancel');
        }
        this.pendingApply = false;
        this.emit('close');
      });
      this.applyBtn?.addEventListener('click', () => {
        if (!this.attemptConfirm()) return;
        this.pendingApply = true;
        Modal.getOrCreateInstance(this.panelEl).hide();
      });
    }

    // Inline has no Cancel button in the recorded prototype; this only
    // covers a caller-added one sharing the same data attribute. Modal's
    // Cancel/× both carry data-bs-dismiss, so their cancel+revert is handled
    // once, centrally, by the hidden.bs.modal listener above — handling it
    // here too would double-fire `cancel`.
    if (this.inline) {
      this.cancelBtns.forEach((btn) => btn.addEventListener('click', () => {
        this.resetDraftToCommitted();
        this.closeInline({ skipValidation: true });
        this.emit('cancel');
      }));
    }
  }

  // -- open / close -----------------------------------------------------------

  onTriggerClick() {
    if (this.cfg.disabled) return;
    if (this.inline) {
      if (this.isOpen) this.closeInline();
      else this.openInline();
    } else {
      Modal.getOrCreateInstance(this.panelEl).show();
    }
  }

  openInline() {
    Collapse.getOrCreateInstance(this.panelEl, { toggle: false }).show();
  }

  closeInline({ skipValidation = false } = {}) {
    if (!skipValidation && !this.attemptConfirm()) return false;
    Collapse.getOrCreateInstance(this.panelEl, { toggle: false }).hide();
    return true;
  }

  // Validates, and on success builds + commits the payload and fires
  // change/apply. Used by the modal's Apply button and by inline's
  // close-via-trigger gesture — the recorded prototype has no separate
  // "Apply" affordance inline, closing the panel *is* the confirm gesture.
  attemptConfirm() {
    if (this.cfg.requireConfirmation && !this.validateSelection()) {
      this.showValidation();
      return false;
    }
    const payload = this.buildPayload();
    if (payload) {
      this.commit(payload);
      this.emit('change', payload);
      this.emit('apply', payload);
    }
    return true;
  }

  validateSelection() {
    return Boolean(this.draftDate && this.draftSlotId);
  }

  showValidation(message) {
    if (!this.validationEl || !this.validationTextEl) return;
    const text = message || (this.inline ? LABELS.requiredInline : LABELS.requiredModal);
    this.validationTextEl.textContent = text;
    this.validationEl.hidden = false;
    this.announce(text);
  }

  hideValidation() {
    if (this.validationEl) this.validationEl.hidden = true;
  }

  // Whole-control "required" error. The class goes on the root (not just the
  // trigger) so the panel border and the relocated feedback can restyle with
  // it; `.is-invalid` stays on the trigger for the Bootstrap border colour.
  // Public so callers that don't submit a native <form> (e.g. a stepper's
  // Continue button) can raise the same state.
  showInvalid() {
    this.root.classList.add('dtsp--invalid');
    this.triggerEl?.classList.add('is-invalid');
    this.triggerEl?.setAttribute('aria-invalid', 'true');
    if (this.feedbackEl?.id) this.triggerEl?.setAttribute('aria-describedby', this.feedbackEl.id);
    this.announce(this.feedbackEl?.textContent || '');
  }

  clearInvalid() {
    this.root.classList.remove('dtsp--invalid');
    this.triggerEl?.classList.remove('is-invalid');
    this.triggerEl?.removeAttribute('aria-invalid');
    this.triggerEl?.removeAttribute('aria-describedby');
  }

  handleFormSubmit(e) {
    if (!this.cfg.required || this.committed || this.cfg.disabled) return;
    e.preventDefault();
    this.showInvalid();
    this.triggerEl?.focus();
  }

  resetDraftToCommitted() {
    if (this.committed) {
      this.draftDate = this.committed.value.date;
      this.draftSlotId = this.committed.slot.id;
      this.draftGroup = this.committed.slot.group;
    } else {
      this.draftDate = this.defaultActiveDate;
      this.draftSlotId = null;
      this.draftGroup = null;
    }
  }

  // -- selection --------------------------------------------------------------

  selectDate(dateStr) {
    if (dateStr === this.draftDate) return;
    const previousDate = this.draftDate;
    this.draftDate = dateStr;
    if (this.cfg.resetTimeOnDateChange) {
      this.draftSlotId = null;
      this.draftGroup = null;
    }
    this.hideValidation();
    this.updateDateStripSelection();
    this.renderGroups();
    this.emit('datechange', { date: dateStr, previousDate });
    this.emitChangeAndMaybeAutoCollapse();
  }

  selectSlot(slotId, time, group) {
    this.draftSlotId = slotId;
    this.draftGroup = group;
    this.hideValidation();
    this.updateSlotSelection();
    this.emit('slotselect', { slotId, time });
    this.emitChangeAndMaybeAutoCollapse();
  }

  // Shared by both selectDate() and selectSlot(): whichever one completes
  // the draft (date + time both set — normally the slot click, since
  // resetTimeOnDateChange clears the slot on a date change by default) fires
  // 'change'/'apply' the same way, and auto-collapses inline the same way —
  // on the first selection *and* on every later edit of an already-committed
  // value. There's no re-entrancy risk doing this unconditionally: closing
  // the panel here only calls Collapse.hide(), which doesn't feed back into
  // selectDate()/selectSlot() (nothing re-opens the panel or re-runs a
  // selection as a result), so this can't loop even though it now fires on
  // every completed change rather than only the first one.
  emitChangeAndMaybeAutoCollapse() {
    const payload = this.buildPayload();
    if (payload) {
      this.emit('change', payload);
      if (!this.cfg.requireConfirmation) {
        this.commit(payload);
        this.emit('apply', payload);
      }
    }
    if (this.inline && this.isOpen && payload) {
      this.closeInline({ skipValidation: !this.cfg.requireConfirmation });
    }
  }

  buildPayload() {
    if (!this.draftDate || !this.draftSlotId) return null;
    const entry = this.availabilityMap.get(this.draftDate);
    const slot = entry?.slots.find((s) => s.id === this.draftSlotId);
    if (!slot) return null;
    return buildPickerPayload({ date: this.draftDate, slot, group: this.draftGroup, timeFormat: this.cfg.timeFormat });
  }

  commit(payload) {
    this.committed = payload;
    if (this.hiddenInput) {
      this.hiddenInput.value = payload.value.datetimeLocal;
      this.hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.clearInvalid();
    this.updateTriggerDisplay();
  }

  // -- rendering ----------------------------------------------------------

  updateTriggerDisplay() {
    if (!this.triggerPrimaryEl || !this.triggerSecondaryEl) return;
    if (this.committed) {
      const primary = `${formatToken(this.committed.value.date, this.cfg.dateFormat)} · ${this.committed.display.time}`;
      this.triggerPrimaryEl.textContent = primary;
      this.triggerSecondaryEl.textContent = LABELS.clickToModify;
    } else {
      this.triggerPrimaryEl.textContent = this.cfg.triggerLabel;
      this.triggerSecondaryEl.textContent = this.cfg.triggerDescription;
    }
  }

  renderDateStrip() {
    if (!this.dateStripEl) return;
    const dates = enumerateDates(this.min, this.max);
    const today = todayISO();
    const frag = document.createDocumentFragment();

    dates.forEach((dateStr) => {
      const disabled = isDateDisabledCore(dateStr, { min: this.min, max: this.max, disabledSet: this.disabledSet, rule: this.dateDisabledRule });
      const entry = this.availabilityMap.get(dateStr);
      const fullyBooked = entry?.status === 'full'
        || (entry?.slots?.length > 0 && entry.slots.every((s) => s.status === 'booked'));
      const selected = dateStr === this.draftDate;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dtsp__date-item';
      btn.setAttribute('role', 'option');
      btn.dataset.date = dateStr;
      btn.setAttribute('aria-selected', String(selected));

      if (selected) btn.classList.add('dtsp__selected');
      if (dateStr === today) btn.classList.add('dtsp__date-item--today');

      if (disabled) {
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
        btn.tabIndex = -1;
        btn.setAttribute('aria-label', `${formatToken(dateStr, 'ddd, MMM D')} — unavailable`);
      } else {
        if (fullyBooked) {
          btn.classList.add('dtsp__date-item--full');
          btn.title = 'Fully booked';
        }
        btn.tabIndex = selected ? 0 : -1;
      }

      const [top, bottom] = formatDateStripParts(dateStr, this.cfg.dateFormat);
      const dow = document.createElement('span');
      dow.className = 'dtsp__date-dow';
      dow.textContent = top;
      const num = document.createElement('span');
      num.className = 'dtsp__date-num';
      num.textContent = bottom;
      btn.append(dow, num);
      // Never color-only (§14): a fully booked date gets real text, not
      // just a tinted pill.
      if (!disabled && fullyBooked) {
        const badge = document.createElement('span');
        badge.className = 'dtsp__date-full';
        badge.textContent = 'Full';
        btn.append(badge);
      }
      frag.append(btn);
    });

    this.dateStripEl.replaceChildren(frag);
    this.ensureRovingTabIndex(this.dateStripEl, '.dtsp__date-item');
    this.scrollDateIntoView(this.draftDate);
  }

  updateDateStripSelection() {
    this.dateStripEl?.querySelectorAll('.dtsp__date-item').forEach((btn) => {
      const selected = btn.dataset.date === this.draftDate;
      btn.classList.toggle('dtsp__selected', selected);
      btn.setAttribute('aria-selected', String(selected));
      if (!btn.disabled) btn.tabIndex = selected ? 0 : -1;
    });
  }

  scrollDateIntoView(dateStr) {
    const el = this.dateStripEl?.querySelector(`.dtsp__date-item[data-date="${dateStr}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  pageDateStrip(direction) {
    if (!this.dateStripEl) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.dateStripEl.scrollBy({ left: direction * this.dateStripEl.clientWidth, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  renderGroups() {
    if (!this.groupsEl) return;
    if (this.slotsState === 'loading') return this.renderGroupsSkeleton();
    if (this.slotsState === 'error') return this.renderGroupsMessage(LABELS.error, 'text-danger');

    const entry = this.availabilityMap.get(this.draftDate);
    const slots = entry?.slots ?? [];
    if (!slots.length || entry?.status === 'closed') {
      return this.renderGroupsMessage(LABELS.empty, 'text-muted');
    }

    const buckets = new Map(PERIODS.map((p) => [p, []]));
    slots.forEach((slot) => buckets.get(bucketForTime(slot.time))?.push(slot));

    const frag = document.createDocumentFragment();
    let anyRendered = false;
    PERIODS.forEach((period) => {
      const periodSlots = buckets.get(period);
      if (!periodSlots.length) return;
      anyRendered = true;
      periodSlots.sort((a, b) => a.time.localeCompare(b.time));
      frag.append(this.buildGroupEl(period, periodSlots));
    });

    if (!anyRendered) return this.renderGroupsMessage(LABELS.empty, 'text-muted');

    this.groupsEl.replaceChildren(frag);
    this.ensureRovingTabIndex(this.groupsEl, '.dtsp__slot');
  }

  buildGroupEl(period, slots) {
    const group = document.createElement('div');
    group.className = 'dtsp__group';

    if (this.cfg.showPeriodGroups) {
      const title = document.createElement('h3');
      title.className = 'dtsp__group-title';
      title.textContent = period;
      if (this.cfg.showPeriodTimeRange) {
        const first = formatTime(slots[0].time, this.cfg.timeFormat);
        const last = formatTime(slots[slots.length - 1].time, this.cfg.timeFormat);
        const range = document.createElement('span');
        range.className = 'dtsp__group-range text-muted';
        range.textContent = ` (${first} – ${last})`;
        title.append(range);
      }
      group.append(title);
    }

    const row = document.createElement('div');
    row.className = 'row row-cols-3 g-2';
    slots.forEach((slot) => {
      const col = document.createElement('div');
      col.className = 'col';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn dtsp__slot';
      btn.setAttribute('role', 'option');
      btn.dataset.slotId = slot.id;
      btn.dataset.time = slot.time;
      btn.dataset.group = period;
      const selected = slot.id === this.draftSlotId;
      btn.setAttribute('aria-selected', String(selected));
      if (selected) btn.classList.add('dtsp__selected');
      if (slot.status === 'booked') {
        btn.classList.add('dtsp__slot--booked');
        btn.disabled = true;
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.tabIndex = -1;
      }
      btn.textContent = formatTime(slot.time, this.cfg.timeFormat);
      col.append(btn);
      row.append(col);
    });
    group.append(row);
    return group;
  }

  renderGroupsSkeleton() {
    const frag = document.createDocumentFragment();
    PERIODS.forEach(() => {
      const group = document.createElement('div');
      group.className = 'dtsp__group placeholder-glow';
      const row = document.createElement('div');
      row.className = 'row row-cols-3 g-2';
      for (let i = 0; i < 3; i += 1) {
        const col = document.createElement('div');
        col.className = 'col';
        col.innerHTML = '<span class="placeholder dtsp__slot-skeleton w-100"></span>';
        row.append(col);
      }
      group.append(row);
      frag.append(group);
    });
    this.groupsEl.replaceChildren(frag);
  }

  renderGroupsMessage(text, colorClass) {
    const p = document.createElement('p');
    p.className = `dtsp__empty small mb-0 ${colorClass}`;
    p.textContent = text;
    this.groupsEl.replaceChildren(p);
    this.announce(text);
  }

  updateSlotSelection() {
    this.groupsEl?.querySelectorAll('.dtsp__slot').forEach((btn) => {
      const selected = btn.dataset.slotId === this.draftSlotId;
      btn.classList.toggle('dtsp__selected', selected);
      btn.setAttribute('aria-selected', String(selected));
    });
  }

  // -- keyboard nav ---------------------------------------------------------

  ensureRovingTabIndex(container, selector) {
    const items = [...container.querySelectorAll(`${selector}:not(:disabled)`)];
    if (!items.some((el) => el.tabIndex === 0)) items[0]?.setAttribute('tabindex', '0');
  }

  focusItem(container, el) {
    container.querySelectorAll('[tabindex="0"]').forEach((n) => n.setAttribute('tabindex', '-1'));
    el.setAttribute('tabindex', '0');
    el.focus();
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  onDateStripKeydown(e) {
    const items = [...this.dateStripEl.querySelectorAll('.dtsp__date-item:not(:disabled)')];
    const currentIndex = items.indexOf(document.activeElement);
    if (currentIndex === -1) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.selectDate(items[currentIndex].dataset.date);
      return;
    }
    let nextIndex = null;
    if (e.key === 'ArrowRight') nextIndex = Math.min(currentIndex + 1, items.length - 1);
    else if (e.key === 'ArrowLeft') nextIndex = Math.max(currentIndex - 1, 0);
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = items.length - 1;
    else return;
    e.preventDefault();
    this.focusItem(this.dateStripEl, items[nextIndex]);
  }

  onGroupsKeydown(e) {
    const items = [...this.groupsEl.querySelectorAll('.dtsp__slot:not(:disabled)')];
    const current = document.activeElement;
    const currentIndex = items.indexOf(current);
    if (currentIndex === -1) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.selectSlot(current.dataset.slotId, current.dataset.time, current.dataset.group);
      return;
    }
    const groups = [...this.groupsEl.querySelectorAll('.dtsp__group')];
    const currentGroupIndex = groups.findIndex((g) => g.contains(current));
    const indexInGroup = [...groups[currentGroupIndex].querySelectorAll('.dtsp__slot:not(:disabled)')].indexOf(current);

    let target = null;
    if (e.key === 'ArrowRight') target = items[Math.min(currentIndex + 1, items.length - 1)];
    else if (e.key === 'ArrowLeft') target = items[Math.max(currentIndex - 1, 0)];
    else if (e.key === 'Home') target = items[0];
    else if (e.key === 'End') target = items[items.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const adjacent = groups[currentGroupIndex + (e.key === 'ArrowDown' ? 1 : -1)];
      const adjacentItems = adjacent ? [...adjacent.querySelectorAll('.dtsp__slot:not(:disabled)')] : null;
      target = adjacentItems?.length ? adjacentItems[Math.min(indexInGroup, adjacentItems.length - 1)] : current;
    } else return;
    e.preventDefault();
    if (target) this.focusItem(this.groupsEl, target);
  }

  // -- public API -----------------------------------------------------------

  open() {
    if (this.inline) this.openInline();
    else Modal.getOrCreateInstance(this.panelEl).show();
  }

  close() {
    if (this.inline) this.closeInline({ skipValidation: true });
    else Modal.getInstance(this.panelEl)?.hide();
  }

  apply() {
    if (this.inline) return this.closeInline();
    if (!this.attemptConfirm()) return false;
    this.pendingApply = true;
    Modal.getInstance(this.panelEl)?.hide();
    return true;
  }

  cancel() {
    // Modal's hidden.bs.modal listener owns the reset+emit for modal mode
    // (it can't tell "hide() called by cancel()" apart from "hide() called
    // by Escape/backdrop" otherwise); inline has no such listener, so it's
    // done here instead.
    if (this.inline) {
      this.resetDraftToCommitted();
      this.hideValidation();
      this.emit('cancel');
    }
    this.close();
  }

  clear() {
    const previousValue = this.committed;
    this.committed = null;
    this.draftDate = this.defaultActiveDate;
    this.draftSlotId = null;
    this.draftGroup = null;
    if (this.hiddenInput) this.hiddenInput.value = '';
    this.updateTriggerDisplay();
    this.emit('clear', { previousValue });
  }

  getValue() {
    return this.committed;
  }

  setValue(payload) {
    this.committed = payload ?? null;
    this.resetDraftToCommitted();
    if (this.hiddenInput) this.hiddenInput.value = payload?.value?.datetimeLocal ?? '';
    if (this.committed) this.clearInvalid();
    this.updateTriggerDisplay();
  }

  setAvailability(list, { silent = false } = {}) {
    this.availabilityMap = new Map((list ?? []).map((entry) => [entry.date, entry]));
    this.slotsState = 'ready';
    if (!silent) {
      this.renderDateStrip();
      this.renderGroups();
    }
  }

  setSlotsState(state) {
    this.slotsState = state;
    this.renderGroups();
  }

  // See the file header: `isDateDisabled` can't be a static prop, so it
  // arrives here instead of through data-config, potentially after this
  // instance already resolved a default date without it.
  setDateDisabledRule(fn) {
    this.dateDisabledRule = typeof fn === 'function' ? fn : null;
    const stillValid = !isDateDisabledCore(this.draftDate, {
      min: this.min, max: this.max, disabledSet: this.disabledSet, rule: this.dateDisabledRule,
    });
    if (!stillValid && !this.committed) {
      this.defaultActiveDate = resolveDefaultDate({
        initialDate: this.cfg.initialDate,
        min: this.min,
        max: this.max,
        disabledSet: this.disabledSet,
        rule: this.dateDisabledRule,
        warn: (msg) => console.warn(msg),
      });
      this.draftDate = this.defaultActiveDate;
      this.draftSlotId = null;
    }
    if (this.dateStripEl?.childElementCount) {
      this.renderDateStrip();
      this.renderGroups();
    }
  }

  setDisabled(isDisabled) {
    this.cfg.disabled = isDisabled;
    this.root.classList.toggle('dtsp--disabled', isDisabled);
    if (this.triggerEl) this.triggerEl.disabled = isDisabled;
  }

  setLoading(isLoading) {
    this.root.classList.toggle('dtsp--loading', isLoading);
    if (!this.triggerEl) return;
    this.triggerEl.setAttribute('aria-busy', String(isLoading));
    if (isLoading) {
      this.triggerEl.disabled = true;
      if (this.triggerPrimaryEl) this.triggerPrimaryEl.innerHTML = '<span class="placeholder col-8"></span>';
      if (this.triggerSecondaryEl) this.triggerSecondaryEl.innerHTML = '<span class="placeholder col-5"></span>';
    } else {
      this.triggerEl.disabled = this.cfg.disabled;
      this.updateTriggerDisplay();
    }
  }

  announce(text) {
    if (!this.liveEl) return;
    clearTimeout(this._liveTimer);
    this._liveTimer = setTimeout(() => { this.liveEl.textContent = text; }, 120);
  }

  emit(name, detail) {
    this.root.dispatchEvent(new CustomEvent(`dtsp:${name}`, { bubbles: true, detail: { ...detail, instance: this } }));
  }

  destroy() {
    DateTimeSlotPicker.instances.delete(this.root);
  }
}

export const initDateTimeSlotPickers = (scope) => DateTimeSlotPicker.init(scope);
export const getDateTimeSlotPicker = (el) => DateTimeSlotPicker.get(el);
