// Autocomplete controller — hydrates every [data-autocomplete] rendered by
// Autocomplete.astro. Implements the WAI-ARIA combobox pattern (editable
// combobox with a listbox popup, focus stays on the input and the highlighted
// option is announced through aria-activedescendant).
//
// Five pieces of state are kept apart on purpose, and never derived from each
// other: `selected` (committed values), `query` (what the user typed),
// `activeValue` (highlighted option), `isOpen`, and `isFullscreen`. Typing
// never changes the selection, and arrow keys never change it either — only
// commit() (Enter, click, tap) does.
//
// Mobile: one DOM, two presentations. The same shell that is a dropdown on
// desktop turns `position: fixed` (class .is-fullscreen) when a phone can't
// safely show a dropdown. The input is never moved or re-created, so focus and
// the on-screen keyboard survive the switch.
//
// Public API (per element): Autocomplete.get(el) → instance with setOptions,
// setValue, getValue, setSource, setState, setInvalid, setDisabled,
// setReadonly, setRecent, open, close, clear, focus. Events are DOM
// CustomEvents named `autocomplete:<name>` (bubbling), see emit() below.

import { lockScroll, unlockScroll, inertOutside } from './dom-overlay.js';

const DEFAULTS = {
  selectionMode: 'single',
  value: undefined,
  placeholder: '',
  disabled: false,
  readonly: false,
  required: false,
  clearable: true,
  maxSelections: undefined,
  maxVisibleChips: undefined,
  state: 'ready', // 'ready' | 'loading' | 'error' ('empty' is derived from the results)
  debounce: 250,
  minSearchLength: 0,
  openOnFocus: true,
  autoFocus: false,
  closeOnSelect: undefined, // single: true, multiple: false
  closeOnEscape: true,
  closeOnOutsideClick: true,
  closeOnBack: true,
  toggleOnEnter: true,
  backspaceRemovesLast: true,
  wrapNavigation: false,
  pageNavigation: true,
  validateOnBlur: false,
  placement: 'auto',
  mobileMode: 'adaptive',
  keyboardAware: true,
  viewportAware: true,
  safeAreaAware: true,
  maxHeight: 'auto',
  positionStrategy: 'adaptive',
  lockBodyScroll: true,
  showApplyButton: true,
  applyLabel: 'Done',
  inputMode: 'search',
  enterKeyHint: undefined,
  highlightMatch: true,
  showRecent: false,
  showPopular: false,
  searchUrl: undefined,
  invalidFeedback: '',
  selectedVisual: 'none',
  selectedDisplay: 'label',
};

const LABELS = {
  clear: 'Clear selection',
  remove: 'Remove {label}',
  more: '{count} more selected: {labels}',
  fewer: 'Show fewer',
  selectedItems: 'Selected items',
  empty: 'No results found',
  emptyQuery: 'No results for “{query}”',
  loading: 'Searching…',
  error: 'Unable to load results.',
  retry: 'Try again',
  minChars: 'Type at least {min} characters to search',
  limitReached: 'Maximum {max} selections reached.',
  limitOption: 'Selection limit reached',
  selected: '{label} selected',
  removed: '{label} removed',
  results: '{count} results available',
  back: 'Close search',
  recent: 'Recent',
  popular: 'Popular',
  all: 'All',
  requiredMessage: 'Please select an option.',
};

const MOBILE_QUERY = '(max-width: 767.98px), (pointer: coarse) and (max-height: 500px)';
const MIN_DROPDOWN = 200; // px of list a phone needs before it falls back to fullscreen
const EDGE_GAP = 8; // px kept between the dropdown and the viewport edge
const KEYBOARD_GUESS = 0.4; // share of the viewport assumed covered before the keyboard shows
const RECENT_MAX = 3;
const CACHE_MAX = 20;

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

const FOCUSABLE = 'button:not([disabled]):not([hidden]), input:not([disabled]):not([type="hidden"]), [tabindex]:not([tabindex="-1"])';

export class Autocomplete {
  static instances = new WeakMap();

  // Accepts the root or any element inside it (the `id` prop lands on the input).
  static get(el) {
    const root = el.closest('[data-autocomplete]') ?? el;
    return Autocomplete.instances.get(root) ?? new Autocomplete(root);
  }

  static init(scope = document) {
    scope.querySelectorAll('[data-autocomplete]').forEach((el) => Autocomplete.get(el));
  }

  constructor(root) {
    const existing = Autocomplete.instances.get(root);
    if (existing) return existing;
    Autocomplete.instances.set(root, this);

    this.root = root;
    const $ = (sel) => root.querySelector(sel);
    this.field = $('.ac__field');
    this.shell = $('.ac__shell');
    this.control = $('.ac__control');
    this.input = $('.ac__input');
    this.chipsEl = $('.ac__chips');
    this.leadEl = $('.ac__lead');
    this.selectedNameEl = $('[data-ac-selected-name]');
    this.clearBtn = $('.ac__clear');
    this.toggleEl = $('.ac__toggle');
    this.panel = $('.ac__panel');
    this.noteEl = $('.ac__note');
    this.statusEl = $('.ac__status');
    this.list = $('.ac__list');
    this.footer = $('.ac__footer');
    this.doneBtn = $('.ac__done');
    this.backBtn = $('.ac__back');
    this.liveEl = $('[data-ac-live]');
    this.feedbackEl = $('.invalid-feedback');
    this.hiddenHost = $('[data-ac-hidden]');
    this.templates = $('template[data-ac-tpl]');

    const cfg = JSON.parse(root.dataset.config || '{}');
    this.cfg = { ...DEFAULTS, ...cfg, labels: { ...LABELS, ...cfg.labels } };
    this.cfg.applyLabel = cfg.applyLabel ?? DEFAULTS.applyLabel;
    this.multiple = this.cfg.selectionMode === 'multiple';
    this.cfg.closeOnSelect ??= !this.multiple;
    this.max = this.multiple && isFiniteNumber(this.cfg.maxSelections) && this.cfg.maxSelections > 0
      ? Math.floor(this.cfg.maxSelections) : undefined;
    this.id = this.input.id;

    // State
    this.registry = new Map(); // value → option (with stable _i); also holds remote results
    this.opts = [];
    this.selected = [];
    this.query = '';
    this.editing = false;
    this.activeValue = null;
    this.isOpen = false;
    this.isFullscreen = false;
    this.hasFocus = false;
    this.state = this.cfg.state;
    this.flat = [];
    this.nodes = new Map();
    this.recent = [];
    this.chipsExpanded = false;
    this.source = this.cfg.searchUrl ? this.urlSource(this.cfg.searchUrl) : null;
    this.remoteItems = [];
    this.cache = new Map();
    this.seq = 0;
    this.abort = null;
    this.debounceTimer = null;
    this.liveTimer = null;
    this.externalError = '';
    this.strategy = 'absolute';
    this.pendingActivate = null;
    this.skipOpen = false;
    this.releaseInert = null;
    this.pushedHistory = false;
    this.ignorePop = false;
    this.pointerOutside = false;
    this.openAtPress = false;
    this.mobileMql = window.matchMedia(MOBILE_QUERY);

    const optionsScript = $('script[data-ac-options]');
    this.setOptions(optionsScript ? JSON.parse(optionsScript.textContent) : [], { silent: true });
    const initial = cfg.value;
    if (initial != null) this.setValue(initial, undefined, { silent: true });

    this.configureInput();
    this.bind();
    this.syncAll();
    this.initialValues = this.selected.map((o) => o.value);
    if (this.cfg.autoFocus) this.focus();
  }

  // ---------------------------------------------------------------- setup

  configureInput() {
    const c = this.cfg;
    const input = this.input;
    input.setAttribute('inputmode', c.inputMode);
    input.setAttribute('enterkeyhint', c.enterKeyHint ?? (this.source ? 'search' : 'done'));
    input.setAttribute('aria-required', String(!!c.required));
    this.root.dataset.safeArea = String(!!c.safeAreaAware);
    this.setDisabled(c.disabled);
    this.setReadonly(c.readonly);
    if (c.maxHeight !== 'auto') {
      this.panel.style.setProperty('--ac-max', typeof c.maxHeight === 'number' ? `${c.maxHeight}px` : String(c.maxHeight));
    }
  }

  bind() {
    const { input, control, panel, root } = this;
    input.addEventListener('input', () => this.onInput());
    input.addEventListener('keydown', (e) => this.onKeydown(e));
    input.addEventListener('focus', () => this.onFocus());
    input.addEventListener('invalid', () => this.showValidity(false));
    root.addEventListener('focusout', (e) => this.onFocusOut(e));
    this.shell.addEventListener('keydown', (e) => this.onShellKeydown(e));

    // Keep focus on the input for every pointer press inside the component, so
    // the input's blur never fires before the click has selected the option.
    panel.addEventListener('mousedown', (e) => e.preventDefault());
    control.addEventListener('mousedown', (e) => {
      this.openAtPress = this.isOpen; // focusing below may open the list before the click lands
      if (e.target.closest('button') || e.target === input) return;
      e.preventDefault();
      if (!this.cfg.disabled) input.focus();
    });
    control.addEventListener('click', (e) => {
      if (this.cfg.disabled || this.cfg.readonly || e.target.closest('button')) return;
      if (e.target.closest('.ac__toggle') && this.openAtPress && this.isOpen && !this.isFullscreen) this.close();
      else this.open();
    });

    this.list.addEventListener('click', (e) => {
      const el = e.target.closest('[role="option"]');
      if (el) this.commit(this.registry.get(el.dataset.value), 'pointer');
    });
    // pointermove, not mouseover: scrolling the list under a still cursor must
    // not steal the keyboard's highlight.
    this.list.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target.closest('[role="option"]');
      if (el && el.dataset.value !== this.activeValue && el.getAttribute('aria-disabled') !== 'true') {
        this.setActive(el.dataset.value, { scroll: false });
      }
    });

    this.clearBtn.addEventListener('click', () => { this.clear(); this.refocus(); });
    this.chipsEl.addEventListener('click', (e) => {
      const remove = e.target.closest('[data-remove]');
      if (remove) { this.removeValue(remove.dataset.remove, 'chip'); this.refocus(); return; }
      if (e.target.closest('[data-more]')) { this.chipsExpanded = !this.chipsExpanded; this.renderChips(); }
    });
    this.statusEl.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) this.retry(); });
    this.backBtn.addEventListener('click', () => this.close({ restoreFocus: true }));
    this.doneBtn.addEventListener('click', () => this.close({ restoreFocus: true }));

    this.onDocPointer = (e) => {
      const outside = !this.root.contains(e.target);
      this.pointerOutside = outside;
      if (outside && this.isOpen && !this.isFullscreen && this.cfg.closeOnOutsideClick) this.close();
    };
    this.onViewport = () => {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.reflow(); });
    };
    this.onPopState = () => {
      if (this.ignorePop) { this.ignorePop = false; return; }
      if (this.isFullscreen && this.pushedHistory) {
        this.pushedHistory = false;
        this.close({ restoreFocus: true, fromHistory: true });
      }
    };
    this.onTouchMove = (e) => {
      // Block rubber-banding of the page behind the overlay; the results
      // panel scrolls on its own.
      if (!this.panel.contains(e.target)) e.preventDefault();
    };
    this.form = root.closest('form');
    this.form?.addEventListener('reset', () => queueMicrotask(() => {
      this.query = '';
      this.editing = false;
      this.setValue(this.initialValues, undefined, { silent: true });
    }));
  }

  // ------------------------------------------------------------- data

  register(opt) {
    if (opt == null || opt.value == null) return null;
    const value = String(opt.value);
    let known = this.registry.get(value);
    if (!known) {
      known = { ...opt, value, _i: this.registry.size };
      this.registry.set(value, known);
    } else {
      Object.assign(known, opt, { value });
    }
    return known;
  }

  setOptions(list, { silent = false } = {}) {
    this.opts = (list ?? []).map((o) => this.register(o)).filter(Boolean);
    if (!silent) this.render();
  }

  // Values are looked up in the registry; for remote data the consumer passes
  // the option objects too, so chips can show labels that aren't in `options`.
  setValue(value, optionObjects, { silent = false } = {}) {
    optionObjects?.forEach((o) => this.register(o));
    const values = (Array.isArray(value) ? value : value == null || value === '' ? [] : [value]).map(String);
    const opts = values.map((v) => this.registry.get(v)).filter(Boolean);
    this.selected = this.multiple ? opts : opts.slice(0, 1);
    this.syncAll();
    if (!silent) { this.emit('change', this.changeDetail('api')); this.render(); }
  }

  getValue() {
    return this.multiple ? this.selected.map((o) => o.value) : (this.selected[0]?.value ?? null);
  }

  setRecent(values) {
    this.recent = (values ?? []).map(String).slice(0, RECENT_MAX);
    if (this.isOpen) this.render();
  }

  setSource(fn) {
    this.source = fn;
    this.cache.clear();
    this.remoteItems = [];
    this.input.setAttribute('enterkeyhint', this.cfg.enterKeyHint ?? (fn ? 'search' : 'done'));
    if (this.isOpen) this.ensureRemote(true);
  }

  urlSource(url) {
    return async (query, { signal }) => {
      const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`, { signal });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      return res.json();
    };
  }

  get limitReached() {
    return this.max !== undefined && this.countedSelected() >= this.max;
  }

  // Locked (selected but disabled) options can't be removed by the user and
  // don't use up a slot, like any other disabled option.
  countedSelected() {
    return this.selected.filter((o) => !o.disabled).length;
  }

  isSelected(value) {
    return this.selected.some((o) => o.value === value);
  }

  // ----------------------------------------------------------- filtering

  visibleItems() {
    if (this.source) return this.remoteItems;
    const q = fold(this.query.trim());
    if (!q) return this.opts;
    return this.opts
      .map((o, i) => ({ o, i, r: this.rank(o, q) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.o);
  }

  rank(opt, q) {
    const label = fold(opt.label ?? '');
    if (label.startsWith(q)) return 0;
    if (label.split(/[\s\-–(]+/).some((w) => w.startsWith(q))) return 1;
    if (label.includes(q)) return 2;
    if (fold(`${opt.secondaryLabel ?? ''} ${opt.keywords ?? ''}`).includes(q)) return 3;
    return -1;
  }

  groups(items) {
    const { showRecent, showPopular, labels } = this.cfg;
    if (this.query.trim() || (!showRecent && !showPopular)) return [{ id: '', label: '', items }];
    const inItems = new Set(items.map((o) => o.value));
    const recent = showRecent ? this.recent.map((v) => this.registry.get(v)).filter((o) => o && inItems.has(o.value)) : [];
    const taken = new Set(recent.map((o) => o.value));
    const popular = showPopular ? items.filter((o) => o.popular && !taken.has(o.value)) : [];
    popular.forEach((o) => taken.add(o.value));
    const rest = items.filter((o) => !taken.has(o.value));
    const groups = [
      { id: 'recent', label: labels.recent, items: recent },
      { id: 'popular', label: labels.popular, items: popular },
      { id: 'all', label: labels.all, items: rest },
    ].filter((g) => g.items.length);
    return groups.length > 1 ? groups : [{ id: '', label: '', items }];
  }

  // --------------------------------------------------------- rendering

  render() {
    const items = this.visibleItems();
    const groups = this.groups(items);
    this.flat = groups.flatMap((g) => g.items);
    this.nodes.clear();
    const frag = document.createDocumentFragment();
    groups.forEach((g) => {
      if (!g.id) { g.items.forEach((o) => frag.append(this.buildOption(o))); return; }
      const wrap = this.el('li', '', { role: 'presentation' });
      const heading = this.el('span', 'ac__group-label', { id: `${this.id}-g-${g.id}` });
      heading.textContent = g.label;
      const inner = this.el('ul', 'list-unstyled m-0', { role: 'group', 'aria-labelledby': heading.id });
      g.items.forEach((o) => inner.append(this.buildOption(o)));
      wrap.append(heading, inner);
      frag.append(wrap);
    });
    this.list.replaceChildren(frag);
    this.list.hidden = this.flat.length === 0;
    this.list.setAttribute('aria-busy', String(this.state === 'loading'));
    this.root.classList.toggle('is-limit', this.limitReached);
    this.root.dataset.limitReached = String(this.limitReached);

    if (this.pendingActivate && this.flat.length) {
      this.activeValue = null;
      this.step(this.pendingActivate === 'last' ? -1 : 1);
      this.pendingActivate = null;
    }
    if (this.activeValue && !this.nodes.has(this.activeValue)) this.activeValue = null;
    this.applyActive();
    this.renderStatus();
    this.renderNote();
    if (this.isOpen) { this.announceResults(); this.reflow(); }
  }

  el(tag, cls, attrs = {}) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
    return node;
  }

  icon(name) {
    const src = this.templates.content.querySelector(`[data-icon="${name}"]`);
    return src ? src.cloneNode(true) : document.createTextNode('');
  }

  optionId(opt) {
    return `${this.id}-opt-${opt._i}`;
  }

  // Disabled beats every other state, then loading, then the selection limit.
  optionState(opt) {
    const selected = this.isSelected(opt.value);
    const disabled = !!opt.disabled;
    const limited = !disabled && !selected && this.multiple && this.limitReached;
    return { selected, disabled, limited };
  }

  buildOption(opt) {
    const { selected, disabled, limited } = this.optionState(opt);
    const li = this.el('li', 'ac__option', {
      id: this.optionId(opt),
      role: 'option',
      'aria-selected': String(selected),
      'data-value': opt.value,
    });
    if (disabled || limited) li.setAttribute('aria-disabled', 'true');
    li.classList.toggle('is-selected', selected);
    li.classList.toggle('is-disabled', disabled);
    li.classList.toggle('is-limited', limited);

    const visual = this.buildVisual(opt);
    if (visual) li.append(visual);
    const text = this.el('span', 'ac__text');
    const label = this.el('span', 'ac__label');
    this.setHighlighted(label, opt.label ?? '');
    text.append(label);
    li.append(text);
    if (opt.secondaryLabel) {
      const secondary = this.el('span', 'ac__secondary');
      secondary.textContent = opt.secondaryLabel;
      li.append(secondary);
    }
    if (limited) {
      const sr = this.el('span', 'visually-hidden');
      sr.textContent = `, ${this.cfg.labels.limitOption}`;
      li.append(sr);
    }
    // Icons carry state next to the text, so state never relies on colour alone.
    if (selected) li.append(this.mark('check'));
    else if (disabled || limited) li.append(this.mark('block'));
    this.nodes.set(opt.value, li);
    return li;
  }

  mark(name) {
    const wrap = this.el('span', 'ac__mark', { 'aria-hidden': 'true' });
    wrap.append(this.icon(name));
    return wrap;
  }

  buildVisual(opt) {
    if (opt.image) {
      // Decorative by default: the label already names the option. Consumers
      // who need it announced pass imageAlt.
      const img = this.el('img', 'ac__thumb', { src: opt.image, alt: opt.imageAlt ?? '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', () => img.replaceWith(this.fallbackThumb(opt)), { once: true });
      return img;
    }
    if (opt.icon) {
      const wrap = this.el('span', 'ac__thumb ac__thumb--icon', { 'aria-hidden': 'true' });
      const glyph = this.icon('generic');
      glyph.querySelector('.material-symbols-outlined').textContent = String(opt.icon).replace(/-/g, '_');
      wrap.append(glyph);
      return wrap;
    }
    return null;
  }

  fallbackThumb(opt) {
    const span = this.el('span', 'ac__thumb ac__thumb--fallback', { 'aria-hidden': 'true' });
    span.textContent = [...String(opt.label ?? '?')][0].toUpperCase();
    return span;
  }

  // Wraps the matched part in <mark>. The text stays one continuous string for
  // assistive tech (marks are inline, no extra roles or labels).
  setHighlighted(node, text) {
    const q = this.cfg.highlightMatch && !this.source ? fold(this.query.trim()) : '';
    const folded = fold(text);
    const at = q && folded.length === text.length ? folded.indexOf(q) : -1;
    if (at < 0) { node.textContent = text; return; }
    const mark = this.el('mark', 'ac__hit');
    mark.textContent = text.slice(at, at + q.length);
    node.append(text.slice(0, at), mark, text.slice(at + q.length));
  }

  renderChips() {
    const items = this.multiple ? this.selected : [];
    const max = this.cfg.maxVisibleChips;
    const visible = isFiniteNumber(max) && !this.chipsExpanded ? items.slice(0, max) : items;
    const hidden = items.slice(visible.length);
    const { labels } = this.cfg;
    const frag = document.createDocumentFragment();
    visible.forEach((opt) => {
      const li = this.el('li', 'ac__chip');
      const visual = this.buildVisual(opt);
      if (visual) li.append(visual);
      const text = this.el('span', 'ac__chip-label');
      text.textContent = opt.label;
      li.append(text);
      if (opt.disabled) li.classList.add('is-locked');
      else if (!this.cfg.readonly && !this.cfg.disabled) {
        li.append(this.el('button', 'btn-close ac__chip-remove', {
          type: 'button', 'data-remove': opt.value, 'aria-label': fill(labels.remove, { label: opt.label }),
        }));
      }
      frag.append(li);
    });
    if (hidden.length || (this.chipsExpanded && isFiniteNumber(max) && items.length > max)) {
      const li = this.el('li', 'ac__chip ac__chip--more');
      const btn = this.el('button', 'ac__more', {
        type: 'button', 'data-more': '', 'aria-expanded': String(this.chipsExpanded),
      });
      if (this.chipsExpanded) btn.textContent = labels.fewer;
      else {
        btn.textContent = `+${hidden.length}`;
        btn.setAttribute('aria-label', fill(labels.more, { count: hidden.length, labels: hidden.map((o) => o.label).join(', ') }));
      }
      li.append(btn);
      frag.append(li);
    }
    // Read the count before replaceChildren(), which empties the fragment.
    const hasChips = frag.childNodes.length > 0;
    this.chipsEl.replaceChildren(frag);
    this.chipsEl.hidden = !hasChips;
  }

  renderStatus() {
    const { labels } = this.cfg;
    const node = this.statusEl;
    node.replaceChildren();
    let kind = '';
    if (this.state === 'loading') kind = 'loading';
    else if (this.state === 'error') kind = 'error';
    else if (this.flat.length === 0) kind = this.source && this.query.trim().length < this.cfg.minSearchLength ? 'min' : 'empty';
    node.hidden = !kind;
    node.dataset.kind = kind;
    if (!kind) return;
    const text = this.el('span', 'ac__status-text');
    if (kind === 'loading') {
      node.append(this.icon('spinner'));
      text.textContent = labels.loading;
    } else if (kind === 'error') {
      text.textContent = labels.error;
    } else if (kind === 'min') {
      text.textContent = fill(labels.minChars, { min: this.cfg.minSearchLength });
    } else {
      text.textContent = this.query.trim() ? fill(labels.emptyQuery, { query: this.query.trim() }) : labels.empty;
    }
    node.append(text);
    if (kind === 'error') {
      const retry = this.el('button', 'btn btn-sm btn-outline-danger ms-auto', { type: 'button', 'data-retry': '' });
      retry.textContent = labels.retry;
      node.append(retry);
    }
  }

  renderNote() {
    const show = this.multiple && this.max !== undefined && this.limitReached;
    this.noteEl.hidden = !show;
    this.noteEl.textContent = show ? fill(this.cfg.labels.limitReached, { max: this.max }) : '';
  }

  syncAll() {
    this.syncInput();
    this.renderChips();
    this.syncHidden();
    this.syncClear();
    this.validate({ silent: true });
    this.root.dataset.count = String(this.countedSelected());
  }

  syncInput() {
    const single = !this.multiple && this.selected[0];
    if (!this.editing) this.input.value = single ? this.displayText(single) : '';
    this.input.placeholder = this.multiple && this.selected.length ? '' : (this.cfg.placeholder ?? '');
    this.syncLead(single);
  }

  // What the closed control shows for the selected option. `secondaryLabel`
  // falls back to the label so an option without one never renders blank.
  displayText(opt) {
    return this.cfg.selectedDisplay === 'secondaryLabel' ? (opt.secondaryLabel ?? opt.label) : opt.label;
  }

  // Leading image/icon of the selected option (single select, opt-in). Reuses
  // the option-row visual so the flag in the list and in the control match.
  syncLead(single) {
    if (this.selectedNameEl) this.selectedNameEl.textContent = single ? single.label : '';
    if (!this.leadEl) return;
    if (this.leadEl.dataset.value === (single?.value ?? '') && single) return;
    const visual = single ? this.buildVisual(single) : null;
    this.leadEl.replaceChildren(...(visual ? [visual] : []));
    this.leadEl.dataset.value = single?.value ?? '';
    this.leadEl.hidden = !visual;
  }

  syncHidden() {
    const name = this.root.dataset.name;
    if (!name || !this.hiddenHost) return;
    const values = this.multiple ? this.selected.map((o) => o.value) : [this.selected[0]?.value ?? ''];
    this.hiddenHost.replaceChildren(...values.map((v) => {
      const hidden = this.el('input', '', { type: 'hidden', name, value: v });
      hidden.disabled = !!this.cfg.disabled;
      return hidden;
    }));
  }

  syncClear() {
    const has = this.selected.some((o) => !o.disabled) || (this.editing && this.query !== '');
    // Multi-select removes items through their chips, so it never shows the clear button.
    this.clearBtn.hidden = !(this.cfg.clearable && !this.multiple && has && !this.cfg.disabled && !this.cfg.readonly);
  }

  // ------------------------------------------------------------ actions

  // Selection rules, in order: valid option → not disabled → component
  // editable → not loading → toggle/limit. A disabled option always fails.
  commit(opt, via = 'pointer') {
    if (!opt || opt.disabled) return false;
    if (this.cfg.disabled || this.cfg.readonly || this.state === 'loading') return false;
    const labels = this.cfg.labels;

    if (this.multiple) {
      if (this.isSelected(opt.value)) {
        if (via === 'keyboard' && !this.cfg.toggleOnEnter) return false;
        return this.removeValue(opt.value, 'toggle');
      }
      if (this.limitReached) {
        this.announce(fill(labels.limitReached, { max: this.max }));
        return false;
      }
      this.selected.push(opt);
    } else {
      this.selected = [opt];
    }

    if (this.cfg.showRecent) this.recent = [opt.value, ...this.recent.filter((v) => v !== opt.value)].slice(0, RECENT_MAX);
    this.editing = !this.multiple ? false : this.editing;
    if (!this.multiple) this.query = '';
    this.syncAll();
    this.emit('select', { option: opt, ...this.changeDetail(via) });
    this.emit('change', this.changeDetail(via));
    this.announce(fill(labels.selected, { label: opt.label }));
    if (this.cfg.closeOnSelect) this.close({ restoreFocus: true });
    else { this.render(); this.refocus(); }
    return true;
  }

  removeValue(value, via = 'api') {
    const opt = this.selected.find((o) => o.value === value);
    if (!opt || opt.disabled || this.cfg.disabled || this.cfg.readonly) return false;
    this.selected = this.selected.filter((o) => o !== opt);
    this.syncAll();
    this.emit('remove', { option: opt, ...this.changeDetail(via) });
    this.emit('change', this.changeDetail(via));
    this.announce(fill(this.cfg.labels.removed, { label: opt.label }));
    if (this.isOpen) this.render();
    return true;
  }

  clear({ silent = false, all = false } = {}) {
    if (!all && (this.cfg.disabled || this.cfg.readonly)) return;
    const before = this.selected.length;
    this.selected = this.selected.filter((o) => o.disabled); // locked options stay
    this.query = '';
    this.editing = false;
    this.syncAll();
    if (this.source) { this.remoteItems = []; }
    if (this.isOpen) { this.scheduleSearch(true); this.render(); }
    if (!silent) {
      this.emit('clear', this.changeDetail('clear'));
      if (before !== this.selected.length) this.emit('change', this.changeDetail('clear'));
      this.announce(this.cfg.labels.clear);
    }
  }

  changeDetail(reason) {
    const count = this.countedSelected();
    return {
      reason,
      value: this.getValue(),
      values: this.selected.map((o) => o.value),
      options: this.selected.map((o) => ({ ...o })),
      count,
      max: this.max ?? null,
      remaining: this.max === undefined ? null : Math.max(0, this.max - count),
      limitReached: this.limitReached,
    };
  }

  emit(name, detail = {}) {
    this.root.dispatchEvent(new CustomEvent(`autocomplete:${name}`, { bubbles: true, detail: { ...detail, instance: this } }));
  }

  refocus() {
    if (document.activeElement !== this.input) {
      this.skipOpen = true;
      this.input.focus({ preventScroll: true });
      this.skipOpen = false;
    }
  }

  focus() { this.input.focus(); }

  setDisabled(disabled) {
    this.cfg.disabled = !!disabled;
    this.input.disabled = this.cfg.disabled;
    this.root.classList.toggle('is-disabled', this.cfg.disabled);
    if (this.cfg.disabled && this.isOpen) this.close();
    this.syncHidden();
    this.renderChips();
    this.syncClear();
  }

  setReadonly(readonly) {
    this.cfg.readonly = !!readonly;
    this.input.readOnly = this.cfg.readonly;
    this.input.setAttribute('aria-readonly', String(this.cfg.readonly));
    this.root.classList.toggle('is-readonly', this.cfg.readonly);
    if (this.cfg.readonly && this.isOpen) this.close();
    this.renderChips();
    this.syncClear();
  }

  setState(state) {
    this.state = ['loading', 'error'].includes(state) ? state : 'ready';
    if (this.state === 'loading') this.announce(this.cfg.labels.loading);
    if (this.state === 'error') this.announce(this.cfg.labels.error);
    this.render();
  }

  // ------------------------------------------------------------ open/close

  open({ activate = null } = {}) {
    if (this.isOpen || this.cfg.disabled || this.cfg.readonly) return;
    this.isOpen = true;
    this.pendingActivate = activate;
    this.root.classList.add('is-open');
    this.input.setAttribute('aria-expanded', 'true');
    this.panel.classList.add('show');
    this.strategy = this.resolveStrategy();
    document.addEventListener('pointerdown', this.onDocPointer, true);
    window.addEventListener('resize', this.onViewport);
    window.addEventListener('orientationchange', this.onViewport);
    window.addEventListener('scroll', this.onViewport, true);
    window.visualViewport?.addEventListener('resize', this.onViewport);
    window.visualViewport?.addEventListener('scroll', this.onViewport);
    if (this.shouldUseFullscreen(true)) this.enterFullscreen();
    if (this.source && !this.editing) this.ensureRemote();
    this.render();
    this.emit('open');
  }

  close({ restoreFocus = false, fromHistory = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.pendingActivate = null;
    clearTimeout(this.debounceTimer);
    this.root.classList.remove('is-open');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.panel.classList.remove('show', 'is-top', 'is-fixed');
    this.panel.removeAttribute('style');
    if (this.cfg.maxHeight !== 'auto') {
      this.panel.style.setProperty('--ac-max', typeof this.cfg.maxHeight === 'number' ? `${this.cfg.maxHeight}px` : String(this.cfg.maxHeight));
    }
    this.activeValue = null;
    document.removeEventListener('pointerdown', this.onDocPointer, true);
    window.removeEventListener('resize', this.onViewport);
    window.removeEventListener('orientationchange', this.onViewport);
    window.removeEventListener('scroll', this.onViewport, true);
    window.visualViewport?.removeEventListener('resize', this.onViewport);
    window.visualViewport?.removeEventListener('scroll', this.onViewport);

    const wasFullscreen = this.isFullscreen;
    if (wasFullscreen) this.exitFullscreen({ fromHistory });
    // The query is scratch text; the committed selection is what the input
    // shows again once the list is gone.
    this.query = '';
    this.editing = false;
    this.abort?.abort();
    this.syncInput();
    this.syncClear();
    if (restoreFocus) this.refocus();
    this.emit('close', { fullscreen: wasFullscreen });
  }

  // ------------------------------------------------------ mobile / viewport

  isMobile() {
    return this.mobileMql.matches;
  }

  probeInsets() {
    if (!this.cfg.safeAreaAware) return { top: 0, bottom: 0 };
    const probe = this.el('div', '', { 'aria-hidden': 'true' });
    probe.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
    document.body.append(probe);
    const cs = getComputedStyle(probe);
    const insets = { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
    probe.remove();
    return insets;
  }

  // Usable room above and below the control, measured against the visual
  // viewport so an open keyboard and browser chrome are already excluded.
  space({ guessKeyboard = false } = {}) {
    const c = this.cfg;
    const rect = this.control.getBoundingClientRect();
    const vv = c.keyboardAware ? window.visualViewport : null;
    let top = vv ? vv.offsetTop : 0;
    let bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    // Before the keyboard has appeared its height is unknown; on touch devices
    // assume it is about to cover the lower part of the screen.
    if (guessKeyboard && c.keyboardAware && window.matchMedia('(pointer: coarse)').matches && (!vv || Math.abs(vv.height - window.innerHeight) < 1)) {
      bottom -= window.innerHeight * KEYBOARD_GUESS;
    }
    const insets = this.probeInsets();
    top += insets.top;
    bottom -= insets.bottom;
    return { above: rect.top - top - EDGE_GAP, below: bottom - rect.bottom - EDGE_GAP };
  }

  shouldUseFullscreen(opening) {
    const mode = this.cfg.mobileMode;
    if (!this.isMobile() || mode === 'dropdown') return false;
    if (mode === 'fullscreen') return true;
    const { above, below } = this.space({ guessKeyboard: opening });
    return Math.max(above, below) < MIN_DROPDOWN;
  }

  resolveStrategy() {
    const pref = this.cfg.positionStrategy;
    if (pref !== 'adaptive') return pref;
    // A clipping ancestor would cut an absolutely positioned list off.
    for (let n = this.root.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) return 'fixed';
    }
    return 'absolute';
  }

  reflow() {
    if (!this.isOpen) return;
    if (this.isFullscreen) { this.fitFullscreen(); return; }
    if (this.shouldUseFullscreen(false)) { this.enterFullscreen(); return; }
    this.position();
  }

  position() {
    const c = this.cfg;
    const panel = this.panel;
    if (!c.viewportAware) {
      panel.classList.remove('is-top');
      panel.style.removeProperty('--ac-avail');
    }
    let top = c.placement === 'top';
    if (c.viewportAware) {
      const { above, below } = this.space();
      const cap = this.maxHeightPx();
      const need = Math.min(panel.scrollHeight, cap);
      if (c.placement === 'auto') top = below < need && above > below;
      panel.style.setProperty('--ac-avail', `${Math.max(0, top ? above : below)}px`);
    }
    panel.classList.toggle('is-top', top);
    panel.classList.toggle('is-fixed', this.strategy === 'fixed');
    if (this.strategy === 'fixed') {
      const r = this.control.getBoundingClientRect();
      Object.assign(panel.style, {
        left: `${r.left}px`,
        width: `${r.width}px`,
        top: top ? 'auto' : `${r.bottom}px`,
        bottom: top ? `${document.documentElement.clientHeight - r.top}px` : 'auto',
      });
    }
  }

  maxHeightPx() {
    const mh = this.cfg.maxHeight;
    if (mh === 'auto') return Infinity;
    if (isFiniteNumber(mh)) return mh;
    const n = parseFloat(mh);
    if (!Number.isFinite(n)) return Infinity;
    if (String(mh).endsWith('rem')) return n * parseFloat(getComputedStyle(document.documentElement).fontSize);
    return String(mh).endsWith('px') ? n : Infinity;
  }

  enterFullscreen() {
    if (this.isFullscreen) return;
    this.isFullscreen = true;
    // The control leaves normal flow; hold its place so the page doesn't jump.
    this.field.style.minHeight = `${this.shell.offsetHeight}px`;
    this.root.classList.add('is-fullscreen');
    this.panel.classList.remove('is-top', 'is-fixed');
    this.panel.removeAttribute('style');
    this.shell.setAttribute('role', 'dialog');
    this.shell.setAttribute('aria-modal', 'true');
    const label = this.root.querySelector('label');
    if (label) this.shell.setAttribute('aria-labelledby', label.id);
    else this.shell.setAttribute('aria-label', this.input.getAttribute('aria-label') ?? '');
    this.footer.hidden = !(this.multiple && this.cfg.showApplyButton);
    this.releaseInert = inertOutside(this.shell);
    if (this.cfg.lockBodyScroll) {
      lockScroll();
      this.shell.addEventListener('touchmove', this.onTouchMove, { passive: false });
    }
    if (this.cfg.closeOnBack) {
      history.pushState({ acFullscreen: this.id }, '');
      this.pushedHistory = true;
      window.addEventListener('popstate', this.onPopState);
    }
    this.fitFullscreen();
    if (document.activeElement !== this.input) this.input.focus({ preventScroll: true });
    this.emit('fullscreen', { active: true });
  }

  exitFullscreen({ fromHistory = false } = {}) {
    this.isFullscreen = false;
    this.root.classList.remove('is-fullscreen');
    this.field.style.minHeight = '';
    this.shell.removeAttribute('role');
    this.shell.removeAttribute('aria-modal');
    this.shell.removeAttribute('aria-labelledby');
    this.shell.removeAttribute('aria-label');
    this.shell.style.removeProperty('--ac-vv-top');
    this.shell.style.removeProperty('--ac-vv-height');
    this.footer.hidden = true;
    this.releaseInert?.();
    this.releaseInert = null;
    if (this.cfg.lockBodyScroll) {
      unlockScroll();
      this.shell.removeEventListener('touchmove', this.onTouchMove);
    }
    window.removeEventListener('popstate', this.onPopState);
    if (this.pushedHistory && !fromHistory) {
      // Close came from the UI, not Back: drop the entry we pushed.
      this.pushedHistory = false;
      this.ignorePop = true;
      history.back();
    }
    this.pushedHistory = false;
    this.emit('fullscreen', { active: false });
  }

  // On iOS the layout viewport keeps its size while the keyboard covers part of
  // it; the visual viewport reports what is actually visible.
  fitFullscreen() {
    const vv = this.cfg.keyboardAware ? window.visualViewport : null;
    if (vv) {
      this.shell.style.setProperty('--ac-vv-top', `${vv.offsetTop}px`);
      this.shell.style.setProperty('--ac-vv-height', `${vv.height}px`);
    }
  }

  // ------------------------------------------------------------- remote

  scheduleSearch(immediate = false) {
    if (!this.source) return;
    clearTimeout(this.debounceTimer);
    const q = this.query.trim();
    if (q.length < this.cfg.minSearchLength) {
      this.abort?.abort();
      this.seq += 1;
      this.remoteItems = [];
      this.state = 'ready';
      return;
    }
    if (immediate || this.cache.has(q)) { this.runSearch(q); return; }
    // Results for the old query stay visible but inert until the new ones land.
    this.state = 'loading';
    this.debounceTimer = setTimeout(() => this.runSearch(q), this.cfg.debounce);
  }

  ensureRemote(force = false) {
    const q = this.query.trim();
    if (q.length < this.cfg.minSearchLength) return;
    if (force || !this.cache.has(q)) this.runSearch(q, { force });
    else this.remoteItems = this.cache.get(q);
  }

  retry() {
    if (this.source) this.runSearch(this.query.trim(), { force: true });
    else this.emit('retry'); // no source of our own: the consumer decides how to recover
    this.refocus();
  }

  async runSearch(q, { force = false } = {}) {
    if (!force && this.cache.has(q)) {
      this.abort?.abort();
      this.remoteItems = this.cache.get(q);
      this.state = 'ready';
      this.render();
      return;
    }
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const seq = ++this.seq;
    this.state = 'loading';
    this.announce(this.cfg.labels.loading);
    this.render();
    this.emit('search', { query: q });
    try {
      const items = (await this.source(q, { signal: controller.signal })) ?? [];
      if (seq !== this.seq) return; // a newer request superseded this one
      const registered = items.map((o) => this.register(o)).filter(Boolean);
      this.cache.set(q, registered);
      if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
      this.remoteItems = registered;
      this.state = 'ready';
    } catch (err) {
      if (seq !== this.seq || err?.name === 'AbortError') return;
      this.state = 'error';
      this.announce(this.cfg.labels.error);
      this.emit('error', { query: q, error: err });
    }
    this.render();
  }

  // ------------------------------------------------------------ events

  onInput() {
    if (this.cfg.readonly) return;
    this.editing = true;
    this.query = this.input.value;
    this.activeValue = null;
    this.syncClear();
    if (this.source) this.scheduleSearch();
    if (this.isOpen) this.render();
    else this.open();
    this.emit('input', { query: this.query });
    if (!this.source) this.emit('search', { query: this.query.trim() });
  }

  onFocus() {
    this.hasFocus = true;
    if (!this.multiple && this.selected[0]) this.input.setSelectionRange(0, this.input.value.length);
    if (this.skipOpen) { this.skipOpen = false; return; }
    this.emit('focus');
    if (this.cfg.openOnFocus && !this.cfg.readonly) this.open();
  }

  onFocusOut(e) {
    if (e.relatedTarget && this.root.contains(e.relatedTarget)) return;
    // Backgrounding the app or switching windows blurs too, but the fullscreen
    // dialog is dismissed explicitly, never by losing focus.
    this.hasFocus = false;
    if (this.isFullscreen) return;
    if (this.isOpen && !(this.pointerOutside && !this.cfg.closeOnOutsideClick)) this.close();
    this.emit('blur');
    if (this.cfg.validateOnBlur) this.validate();
  }

  onShellKeydown(e) {
    if (e.defaultPrevented || !this.isFullscreen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close({ restoreFocus: true });
      return;
    }
    if (e.key !== 'Tab') return;
    // The overlay is a dialog: Tab cycles inside it rather than closing it.
    const items = [...this.shell.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === this.input);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  onKeydown(e) {
    if (this.cfg.disabled || e.isComposing || e.keyCode === 229) return;
    const c = this.cfg;
    const active = this.activeValue ? this.registry.get(this.activeValue) : null;

    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (c.readonly) return;
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        if (!this.isOpen) { this.open({ activate: dir > 0 ? 'first' : 'last' }); return; }
        if (this.state === 'error') { this.retry(); return; }
        this.step(dir);
        return;
      }
      case 'Home':
      case 'End': {
        // While the user is editing text, Home/End move the caret; once they
        // are navigating the list (or have typed nothing) they move the highlight.
        if (!this.isOpen || (this.input.value !== '' && !this.activeValue && this.editing)) return;
        e.preventDefault();
        this.edge(e.key === 'Home' ? 1 : -1);
        return;
      }
      case 'PageDown':
      case 'PageUp': {
        if (!this.isOpen || !c.pageNavigation) return;
        e.preventDefault();
        this.page(e.key === 'PageDown' ? 1 : -1);
        return;
      }
      case 'Enter': {
        if (this.isOpen && active) {
          e.preventDefault(); // consumed: the parent form must not submit
          this.commit(active, 'keyboard');
        } else if (this.isOpen && this.state === 'error') {
          e.preventDefault();
          this.retry();
        } else if (this.isFullscreen) {
          e.preventDefault();
        }
        return;
      }
      case 'Escape': {
        if (this.isFullscreen) {
          e.preventDefault();
          e.stopPropagation();
          this.close({ restoreFocus: true });
        } else if (this.isOpen && c.closeOnEscape) {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        } else if (!this.isOpen && this.editing) {
          this.query = '';
          this.editing = false;
          this.syncInput();
        }
        return;
      }
      case 'Tab': {
        if (!this.isFullscreen && this.isOpen) this.close(); // never selects
        return;
      }
      case 'Backspace': {
        if (!this.multiple || !c.backspaceRemovesLast || c.readonly || this.input.value !== '') return;
        const removable = [...this.selected].reverse().find((o) => !o.disabled);
        if (removable) { e.preventDefault(); this.removeValue(removable.value, 'backspace'); }
        return;
      }
      default:
    }
  }

  // ------------------------------------------------------ active option

  activeIndex() {
    return this.flat.findIndex((o) => o.value === this.activeValue);
  }

  setActive(value, { scroll = true } = {}) {
    this.activeValue = value;
    this.applyActive();
    if (scroll && value) this.scrollToActive();
  }

  applyActive() {
    this.list.querySelector('.is-active')?.classList.remove('is-active');
    const opt = this.activeValue ? this.registry.get(this.activeValue) : null;
    const node = opt ? this.nodes.get(opt.value) : null;
    if (node) {
      node.classList.add('is-active');
      this.input.setAttribute('aria-activedescendant', node.id);
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  // Scrolls only the results panel — never the page — so the active option is
  // visible.
  scrollToActive() {
    const node = this.nodes.get(this.activeValue);
    if (!node) return;
    const p = this.panel;
    const nr = node.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    if (nr.top < pr.top) p.scrollTop -= pr.top - nr.top;
    else if (nr.bottom > pr.bottom) p.scrollTop += nr.bottom - pr.bottom;
  }

  // Moves to the next/previous enabled option; disabled ones are skipped.
  step(dir) {
    const n = this.flat.length;
    if (!n) return;
    let i = this.activeIndex();
    if (i === -1) i = dir > 0 ? -1 : n;
    for (let tries = 0; tries < n; tries += 1) {
      i += dir;
      if (i < 0 || i >= n) {
        if (!this.cfg.wrapNavigation) return;
        i = (i + n) % n;
      }
      if (!this.flat[i].disabled) { this.setActive(this.flat[i].value); return; }
    }
  }

  edge(dir) {
    const list = dir > 0 ? this.flat : [...this.flat].reverse();
    const target = list.find((o) => !o.disabled);
    if (target) this.setActive(target.value);
  }

  page(dir) {
    const n = this.flat.length;
    if (!n) return;
    const row = this.list.querySelector('[role="option"]')?.offsetHeight || 48;
    const rows = Math.max(1, Math.floor(this.panel.clientHeight / row));
    const from = this.activeIndex();
    const start = from === -1 ? (dir > 0 ? -1 : n) : from;
    const target = Math.min(n - 1, Math.max(0, start + dir * rows));
    // Land on the nearest enabled option in the direction of travel, else back.
    const find = (i, d) => {
      for (let k = i; k >= 0 && k < n; k += d) if (!this.flat[k].disabled) return k;
      return -1;
    };
    const found = find(target, dir) !== -1 ? find(target, dir) : find(target, -dir);
    if (found !== -1) this.setActive(this.flat[found].value);
  }

  // ------------------------------------------------- validation & a11y

  validate({ silent = false } = {}) {
    const c = this.cfg;
    const message = this.externalError || (c.required && this.selected.length === 0 ? c.labels.requiredMessage : '');
    this.input.setCustomValidity(message);
    if (!silent) this.showValidity(!message, message);
    else if (!message && this.root.classList.contains('is-invalid')) this.showValidity(true);
    return !message;
  }

  showValidity(valid, message) {
    const text = message || this.externalError || this.cfg.invalidFeedback || this.cfg.labels.requiredMessage;
    this.control.classList.toggle('is-invalid', !valid);
    this.control.classList.toggle('is-valid', valid && this.cfg.validateOnBlur && this.selected.length > 0);
    this.root.classList.toggle('is-invalid', !valid);
    this.input.setAttribute('aria-invalid', String(!valid));
    if (this.feedbackEl) this.feedbackEl.textContent = text;
    const describedBy = new Set((this.input.dataset.describedby || '').split(' ').filter(Boolean));
    if (!valid && this.feedbackEl) describedBy.add(this.feedbackEl.id);
    this.input.setAttribute('aria-describedby', [...describedBy].join(' '));
    if (!describedBy.size) this.input.removeAttribute('aria-describedby');
  }

  setInvalid(message) {
    this.externalError = message || '';
    this.validate();
  }

  announceResults() {
    if (this.state !== 'ready') return;
    const n = this.flat.length;
    this.announce(n ? fill(this.cfg.labels.results, { count: n }) : (this.query.trim() ? fill(this.cfg.labels.emptyQuery, { query: this.query.trim() }) : this.cfg.labels.empty));
  }

  announce(text) {
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => { this.liveEl.textContent = text; }, 120);
  }

  destroy() {
    if (this.isOpen) this.close();
    Autocomplete.instances.delete(this.root);
  }
}

export const initAutocompletes = (scope) => Autocomplete.init(scope);
export const getAutocomplete = (el) => Autocomplete.get(el);
