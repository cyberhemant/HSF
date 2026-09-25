import { test } from 'node:test';
import assert from 'node:assert/strict';
import examples from 'libphonenumber-js/examples.mobile.json';
import {
  isInternational, detectCountry, formatAsYouType, describe, fromE164, nationalDigits, dialCodeOf, examplePlaceholder,
} from './phone-number-logic.js';
import { phoneCountries } from '../data/phone-countries.js';

test('a valid national number yields one E.164 value', () => {
  const d = describe('(302) 414-8567', 'US');
  assert.equal(d.isValid, true);
  assert.equal(d.e164, '+13024148567');
  assert.equal(d.country, 'US');
  assert.equal(d.national, '(302) 414-8567');
});

test('the national form drops the trunk prefix, the calling code is on screen', () => {
  assert.equal(describe('098765 43210', 'IN').national, '98765 43210');
  assert.equal(describe('98765 43210', 'IN').e164, '+919876543210');
  assert.equal(fromE164('+919876543210').national, '98765 43210');
  assert.equal(examplePlaceholder('IN', examples), '81234 56789');
});

test('an incomplete number never produces a value', () => {
  const d = describe('839', 'US');
  assert.equal(d.isValid, false);
  assert.equal(d.e164, '');
  assert.equal(d.reason, 'TOO_SHORT');
  assert.equal(d.national, '839', 'the visible text is kept as typed');
});

test('a number that is too long reports TOO_LONG', () => {
  assert.equal(describe('302414856700', 'US').reason, 'TOO_LONG');
});

test('empty input is empty, not invalid', () => {
  const d = describe('   ', 'US');
  assert.deepEqual([d.isEmpty, d.isValid, d.e164], [true, false, '']);
});

test('an international entry overrides the selected country', () => {
  const d = describe('+91 98765 43210', 'US');
  assert.equal(d.isValid, true);
  assert.equal(d.e164, '+919876543210');
  assert.equal(d.country, 'IN');
});

test('detectCountry only looks at international entries', () => {
  assert.equal(detectCountry('3024148567'), undefined);
  assert.equal(detectCountry('+1 302 414 8567'), 'US');
  assert.equal(detectCountry('+91 98765'), 'IN');
  assert.equal(detectCountry('+'), undefined);
  assert.equal(isInternational(' +1'), true);
  assert.equal(isInternational('1'), false);
});

test('formatAsYouType uses national or international rules', () => {
  assert.equal(formatAsYouType('3024148567', 'US'), '(302) 414-8567');
  assert.equal(formatAsYouType('+13024148567', 'IN'), '+1 302 414 8567');
});

test('fromE164 splits a stored value into country and national text', () => {
  assert.deepEqual(fromE164('+13024148567'), { country: 'US', national: '(302) 414-8567', e164: '+13024148567' });
  assert.equal(fromE164('not a number'), undefined);
  assert.equal(fromE164(''), undefined);
  assert.equal(fromE164('+1302'), undefined, 'an invalid number is not restored');
});

test('nationalDigits keeps digits only', () => {
  assert.equal(nationalDigits('(302) 414-8567'), '3024148567');
});

test('dialCodeOf and examplePlaceholder', () => {
  assert.equal(dialCodeOf('GB'), '+44');
  assert.equal(examplePlaceholder('US', examples), '(201) 555-0123');
  assert.equal(examplePlaceholder('ZZ', examples), '');
});

test('the country list is complete, sorted, and has no flagless regions', () => {
  const isos = phoneCountries.map((c) => c.iso);
  assert.ok(isos.includes('US') && isos.includes('IN') && isos.includes('GB'));
  assert.ok(!isos.includes('AC') && !isos.includes('TA'));
  const names = phoneCountries.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'en')));
  assert.equal(phoneCountries.find((c) => c.iso === 'US').dialCode, '+1');
  assert.ok(phoneCountries.every((c) => c.name && /^\+\d{1,3}$/.test(c.dialCode)));
});
