// Phone Number — one control, one value. Two visible inputs (an embedded
// Autocomplete for the country / calling code, and a <input type="tel"> for
// the number) collapse into a single E.164 string carried by one hidden input.
// Neither visible input has a `name`, so nothing else is submitted.
//
// Public API (see getPhoneNumber below):
//   getValue()        → "+13024148567", or "" while empty / incomplete / invalid
//   getDetails()      → { value, country, dialCode, national, isValid, isEmpty }
//   setValue(e164)    → restores both inputs from one string
//   setCountry(iso), setDisabled(bool), showInvalid(msg?), clearInvalid(), focus()
// Events (bubbling CustomEvents on the root): phone-number:change, with the
// getDetails() object plus `instance`. Its hidden input also fires a native
// `change`, like a plain form control.
import examples from 'libphonenumber-js/examples.mobile.json';
import { getAutocomplete } from './autocomplete.js';
import {
  describe, detectCountry, formatAsYouType, fromE164, nationalDigits, dialCodeOf, examplePlaceholder, isInternational,
} from './phone-number-logic.js';

const LABELS = {
  required: 'Please enter a phone number.',
  invalid: 'Please enter a valid phone number.',
  tooShort: 'That phone number is too short.',
  tooLong: 'That phone number is too long.',
};

export class PhoneNumber {
  static instances = new WeakMap();

  // Accepts the root or any element inside it.
  static get(el) {
    const root = el.closest('[data-phone-number]') ?? el;
    return PhoneNumber.instances.get(root) ?? new PhoneNumber(root);
  }

  static init(scope = document) {
    scope.querySelectorAll('[data-phone-number]').forEach((el) => PhoneNumber.get(el));
  }

  constructor(root) {
    const existing = PhoneNumber.instances.get(root);
    if (existing) return existing;
    PhoneNumber.instances.set(root, this);

    this.root = root;
    const $ = (sel) => root.querySelector(sel);
    this.field = $('.phone__field');
    this.input = $('.phone__input');
    this.hidden = $('[data-phone-value]');
    this.feedback = $('.invalid-feedback');
    this.status = $('.phone__status');

    const cfg = JSON.parse(root.dataset.config || '{}');
    this.cfg = { ...cfg, labels: { ...LABELS, ...cfg.labels } };
    this.country = cfg.country;
    this.initial = this.hidden.value;
    this.describedBy = (this.input.dataset.describedby || '').split(' ').filter(Boolean);
    this.ac = getAutocomplete($('[data-autocomplete]'));
    this.lastKey = '';

    this.bind();
    this.applyCountry(this.country, { syncPicker: false });
    this.setDisabled(!!cfg.disabled);
    this.lastKey = this.key();
    this.renderStatus();
  }

  bind() {
    this.input.addEventListener('input', (e) => this.onInput(e));
    this.input.addEventListener('blur', () => this.onBlur());
    this.ac.root.addEventListener('autocomplete:change', (e) => this.onCountryChange(e));
    // Clicking anywhere on the field (padding, gap) puts the caret in the number.
    this.field.addEventListener('mousedown', (e) => {
      if (e.target === this.field) { e.preventDefault(); this.input.focus(); }
    });
    this.form = this.root.closest('form');
    // Capture, so a consumer's own submit listener sees `defaultPrevented`.
    this.form?.addEventListener('submit', (e) => this.onSubmit(e), true);
    this.form?.addEventListener('reset', () => setTimeout(() => this.setValue(this.initial, { silent: true })));
  }

  // ------------------------------------------------------------------ state

  entry() {
    return describe(this.input.value, this.country);
  }

  key() {
    const d = this.entry();
    return `${d.country}|${d.e164}`;
  }

  getValue() {
    return this.entry().e164;
  }

  getDetails() {
    const d = this.entry();
    return {
      value: d.e164,
      country: d.country,
      dialCode: dialCodeOf(d.country),
      national: this.input.value,
      isValid: d.isValid,
      isEmpty: d.isEmpty,
    };
  }

  setValue(value, { silent = false } = {}) {
    const parsed = fromE164(value);
    if (parsed) {
      this.applyCountry(parsed.country);
      this.input.value = parsed.national;
    } else {
      this.input.value = '';
    }
    this.clearInvalid();
    this.commit({ silent });
  }

  setCountry(iso) {
    if (!iso || iso === this.country) return;
    const digits = isInternational(this.input.value) ? '' : nationalDigits(this.input.value);
    this.applyCountry(iso);
    if (digits) this.input.value = formatAsYouType(digits, iso);
    this.commit();
  }

  // Keeps country, the picker and the placeholder in step. `syncPicker` is off
  // when the change came from the picker itself.
  applyCountry(iso, { syncPicker = true } = {}) {
    if (!iso) return;
    this.country = iso;
    if (syncPicker && this.ac.getValue() !== iso) this.ac.setValue(iso, undefined, { silent: true });
    this.input.placeholder = this.cfg.placeholder || examplePlaceholder(iso, examples);
  }

  // Writes the hidden value, updates the status mark and announces a change.
  commit({ silent = false } = {}) {
    const d = this.entry();
    if (this.hidden.value !== d.e164) {
      this.hidden.value = d.e164;
      this.hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (d.isValid) this.clearInvalid();
    this.renderStatus(d);
    const key = `${d.country}|${d.e164}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      if (!silent) this.emit('change', this.getDetails());
    }
  }

  renderStatus(d = this.entry()) {
    if (this.status) this.status.hidden = !d.isValid;
  }

  // ----------------------------------------------------------------- events

  onInput(e) {
    // Typing "+44 …" selects that country. A country that is still ambiguous
    // (e.g. "+1") leaves the current one alone.
    const detected = detectCountry(this.input.value);
    if (detected && detected !== this.country) this.applyCountry(detected);

    // Format as the user types, but never while deleting (it would fight the
    // backspace) and only with the caret at the end (it would jump otherwise).
    const inserting = !e.inputType || e.inputType.startsWith('insert');
    const atEnd = this.input.selectionStart === this.input.value.length;
    if (inserting && atEnd) {
      const formatted = formatAsYouType(this.input.value, this.country);
      if (formatted !== this.input.value) this.input.value = formatted;
    }
    this.commit();
  }

  onBlur() {
    const d = this.entry();
    if (d.isValid) this.input.value = d.national; // settle on the canonical national form
    if (d.isEmpty || d.isValid) this.clearInvalid();
    else this.showInvalid();
  }

  onCountryChange(e) {
    if (e.detail.reason === 'api') return;
    this.setCountry(e.detail.value);
    // Autocomplete restores focus to its own input as it closes; hand it on.
    setTimeout(() => this.input.focus());
  }

  // A hidden input is skipped by native constraint validation, so `required`
  // and validity are enforced on submit here (same approach as
  // DateTimeSlotPicker). Callers that don't submit a form call showInvalid().
  onSubmit(e) {
    if (this.cfg.disabled) return;
    const d = this.entry();
    if (d.isValid || (d.isEmpty && !this.cfg.required)) return;
    e.preventDefault();
    this.showInvalid();
    this.input.focus();
  }

  // -------------------------------------------------------------- validity

  message(d) {
    const { labels } = this.cfg;
    if (d.isEmpty) return labels.required;
    if (d.reason === 'TOO_SHORT') return labels.tooShort;
    if (d.reason === 'TOO_LONG') return labels.tooLong;
    return labels.invalid;
  }

  showInvalid(message) {
    const text = message || this.message(this.entry());
    this.field.classList.add('is-invalid');
    this.input.setAttribute('aria-invalid', 'true');
    if (this.feedback) {
      this.feedback.textContent = text;
      this.input.setAttribute('aria-describedby', [...this.describedBy, this.feedback.id].join(' '));
    }
  }

  clearInvalid() {
    this.field.classList.remove('is-invalid');
    this.input.removeAttribute('aria-invalid');
    if (this.feedback) this.feedback.textContent = '';
    if (this.describedBy.length) this.input.setAttribute('aria-describedby', this.describedBy.join(' '));
    else this.input.removeAttribute('aria-describedby');
  }

  // ---------------------------------------------------------------- misc

  setDisabled(disabled) {
    this.cfg.disabled = !!disabled;
    this.input.disabled = !!disabled;
    this.hidden.disabled = !!disabled;
    this.ac.setDisabled(!!disabled);
    this.field.classList.toggle('is-disabled', !!disabled);
  }

  focus() {
    this.input.focus();
  }

  emit(name, detail = {}) {
    this.root.dispatchEvent(new CustomEvent(`phone-number:${name}`, { bubbles: true, detail: { ...detail, instance: this } }));
  }
}

export const initPhoneNumbers = (scope) => PhoneNumber.init(scope);
export const getPhoneNumber = (el) => PhoneNumber.get(el);
