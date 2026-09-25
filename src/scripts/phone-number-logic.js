// Pure phone-number logic for PhoneNumber (no DOM), so it can be unit-tested
// with `node --test`. The component is one control with one value: the E.164
// string. Everything the two visible inputs show is derived from it here.
import {
  AsYouType, parsePhoneNumberFromString, validatePhoneNumberLength, getCountryCallingCode, getExampleNumber,
} from 'libphonenumber-js/min';

export const isInternational = (text) => String(text).trim().startsWith('+');

// The region an international entry ("+44 …") points at, if it is decided yet.
export function detectCountry(text) {
  if (!isInternational(text)) return undefined;
  const typer = new AsYouType();
  typer.input(String(text).trim());
  return typer.getCountry();
}

// Live formatting while typing: national for `country`, or international when
// the text starts with "+".
export function formatAsYouType(text, country) {
  const raw = String(text).trim();
  return isInternational(raw) ? new AsYouType().input(raw) : new AsYouType(country).input(raw);
}

// The number as shown next to its country code: grouped for the region, without
// the domestic trunk prefix ("98765 43210", not "098765 43210"), since the
// calling code is already on screen.
export const displayNational = (parsed) => new AsYouType(parsed.country).input(parsed.nationalNumber);

// What the entry means. `e164` is set only for a valid number, so a
// half-typed number can never be submitted.
export function describe(text, country) {
  const raw = String(text).trim();
  if (!raw) return { isEmpty: true, isValid: false, e164: '', country, reason: '', national: '' };

  const international = isInternational(raw);
  const parsed = international ? parsePhoneNumberFromString(raw) : parsePhoneNumberFromString(raw, country);
  const effective = (international ? (detectCountry(raw) ?? parsed?.country) : undefined) ?? country;
  const isValid = Boolean(parsed?.isValid());
  let reason = '';
  if (!isValid) {
    const length = validatePhoneNumberLength(raw, international ? undefined : country);
    reason = length === 'TOO_SHORT' || length === 'TOO_LONG' ? length : 'INVALID';
  }
  return {
    isEmpty: false,
    isValid,
    e164: isValid ? parsed.number : '',
    country: effective,
    reason,
    national: isValid ? displayNational(parsed) : raw,
  };
}

// E.164 → { country, national } for prefilling both inputs from one value.
export function fromE164(value) {
  const parsed = value ? parsePhoneNumberFromString(String(value).trim()) : undefined;
  if (!parsed?.isValid()) return undefined;
  return { country: parsed.country, national: displayNational(parsed), e164: parsed.number };
}

// Digits the user has typed, kept when the country changes.
export const nationalDigits = (text) => String(text).replace(/\D/g, '');

export const dialCodeOf = (country) => `+${getCountryCallingCode(country)}`;

export function examplePlaceholder(country, examples) {
  try {
    const example = getExampleNumber(country, examples);
    return example ? displayNational(example) : '';
  } catch {
    return '';
  }
}
