// Country list for the Phone Number component: every region libphonenumber-js
// knows, with its name (Intl, English) and calling code. Built once at render
// time, so no country data ships to the browser twice.
import { getCountries, getCountryCallingCode } from 'libphonenumber-js/min';

// No flag file exists for these (see public/flags/README.md).
const NO_FLAG = new Set(['AC', 'TA']);

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

export const phoneCountries = getCountries()
  .filter((iso) => !NO_FLAG.has(iso))
  .map((iso) => ({ iso, name: regionNames.of(iso), dialCode: `+${getCountryCallingCode(iso)}` }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
