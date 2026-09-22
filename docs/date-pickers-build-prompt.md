# Build prompt: Date Range Picker + Date Picker (Heenat Salma Farm)

> Hand this whole file to an AI or developer working in the Heenat prototype repo. It is a specification, not a suggestion: where it gives a string, a class name, a key or a rule, reproduce it exactly.

---

## 0. Role and outcome

You are working in an **Astro 5 + Bootstrap 5.3 (Sass)** prototype for Heenat Salma Farm, an Oman farm-stay brand. Build two components that share one engine:

1. **`DateRangePicker`**: check-in / check-out for the lodge stay flow. It is deliberately *not* a generic date picker. It understands availability (booked, check-in-only, check-out-only), stay length and same-day turnover.
2. **`DatePicker`**: one date, availability-aware. It is the range picker's engine run in `single` mode. It is **not** a second calendar; `DatePicker.astro` is a thin wrapper that gives the single-date API a name so consumers never see range-only props.

Deliverables (all paths relative to the repo root):

| File | Role |
| --- | --- |
| `src/components/DateRangePicker.astro` | Static shell (field, panel, footer, hidden input) + config JSON. Hydrated by the script. |
| `src/components/DatePicker.astro` | Wrapper: `<DateRangePicker mode="single" {...props} />` |
| `src/scripts/date-only.js` | Date-only calendar arithmetic and formatting (no `Date` objects for booking dates) |
| `src/scripts/lodge-date-rules.js` | Pure booking rules on `'YYYY-MM-DD'` strings |
| `src/scripts/date-range-picker.js` | Controller class: rendering, selection, keyboard, availability loading, API, events |
| `src/scripts/dom-overlay.js` | Shared `lockScroll` / `unlockScroll` / `inertOutside` helpers for full-screen overlays |
| `src/scripts/date-only.test.js`, `src/scripts/lodge-date-rules.test.js` | `node:test` unit tests |
| `src/styles/main.scss` | A `.date-range` block (see §9) |
| `src/pages/design-system/index.astro` | Two new sections with live examples, state audit, props, events, behaviour; plus demo script |
| `package.json` | Add `"test": "node --test"` script |

Do not add dependencies. Bootstrap's JS is not used by the pickers; the panel is not a Bootstrap dropdown at runtime.

---

## 1. Project rules you must obey (from `CLAUDE.md`)

Read `CLAUDE.md`, `src/components/`, and the design-system page first. Then:

- **Component reuse.** Reuse `Icon.astro`, `IconButton.astro`, `Button.astro` (variants `text` and `primary`), the shared `.placeholder` / `.placeholder-glow` skeleton primitive, and `showToast()` from `src/scripts/toast.js`. Do not create new components beyond the two above. The single-date picker is a wrapper on the range picker, not a second implementation.
- **Colours from tokens only.** Never write a hex, `rgb()`/`rgba()` literal, or a named colour (`white`, `black`) in SCSS, `<style>`, or inline styles. Use Bootstrap CSS variables (`--bs-primary`, `--bs-body-bg`, `--bs-border-color`, `--bs-secondary-color`, `--bs-danger`, `--bs-heading-color`, `--bs-ink-faint`) or SCSS tokens. Alpha on a token is fine: `rgb(var(--bs-primary-rgb), .1)`. If no token fits, **ask before adding one**.
  - **Pitfall already hit once:** do *not* use `--bs-emphasis-color` for "strong" text. This project never overrides `$body-emphasis-color`, so it resolves to pure black. The footer summary uses `--bs-heading-color` (maroon `$ink`).
- **Dark mode is not a requirement**, but stay ready: reference semantic roles, not palette names (no `maroon`, `sand` in the component); icons use `currentColor`; never rely on colour alone.
- **Prefer native Bootstrap** (`.form-control`, `.form-label`, `.form-text`, `.invalid-feedback`, `.dropdown-menu` styling via `@extend`, `.btn`, `.visually-hidden`) over custom CSS.
- **Merge gate.** Semantic HTML, accessible name, keyboard operable, visible focus, tokens only, stated responsive behaviour, handles long/missing/empty content, honours `prefers-reduced-motion`, minimal props API (enums over booleans), design-system entry with a live example of each variant and state.
- **State audit** for every component (yes/no/n.a. with a reason for each "no") appears on the design-system page. Data states use the shared enum `state = 'ready' | 'loading' | 'empty' | 'error'`. This is exposed as `data-state` on the root, never `isLoading`/`isEmpty` booleans. Skeletons (not spinners) for the month grid because its layout is known.
- Status label: **experimental** (one use: the design-system page). Additive changes only from here.

Design tokens you will lean on (defined in `main.scss` §2): `$maroon #491010` (primary), `$ochre-deep` (secondary/links), `$cream` (body bg), `$ink` (headings), `$ink-soft` (body text), `$ink-faint` (metadata, exposed as `--bs-ink-faint`), `$error` (danger). The focus ring is the shared ochre ring `$focus-ring-box-shadow`; the input focus border is `$input-focus-border-color`. Fonts: Alegreya (serif, headings), Alegreya Sans (sans, body). Icons are Material Symbols via `<Icon name="…" size={…} />`.

---

## 2. Architecture

```
DatePicker.astro ──► DateRangePicker.astro (mode="single")
                        │  renders static shell + <div data-date-range data-config="{json}">
                        ▼
              date-range-picker.js   (class DateRangePicker: DOM, state, events)
                 │        │
                 │        └─► dom-overlay.js   (scroll lock, inert outside)
                 │        └─► toast.js         (showToast: availability error + Retry)
                 ▼
          lodge-date-rules.js   (pure: state per date, range/date validation, summary, presets)
                 ▼
             date-only.js       (pure: 'YYYY-MM-DD' arithmetic and formatting)
```

Principles:
- **Rules are not in the controller.** The controller draws the calendar and moves the selection through the pure functions.
- **The parent owns the value.** The hidden input is the single source of truth. `setValue()` mirrors an external value and **never fires `change`**.
- **One DOM, two presentations**, switched by CSS plus one `matchMedia('(min-width: 768px)')` query.
- **Callbacks can't be props on a build-time Astro component**, so every `onX` is a bubbling `CustomEvent`. Function-valued config (min/max nights as a function of the start date, the availability source) goes through script methods `setRules()` and `setSource()`.

---

## 3. `date-only.js` (pure, no DOM)

**Invariant:** a booking date is a calendar date, not a moment. Every value is a plain `'YYYY-MM-DD'` string (months: `'YYYY-MM'`). All arithmetic is integer arithmetic on a day number. **Never construct a `Date` from a booking date**, so a time zone can never shift one. The only clock read is `todayISO()`.

Exports and behaviour:

- `FARM_TIME_ZONE = 'Asia/Muscat'` (UTC+4, no DST; one fixed zone for v1).
- `MONTH_NAMES` (English full names), `WEEKDAY_NAMES = ['Monday' … 'Sunday']`. **The week starts on Monday**, fixed for v1.
- Internal `daysFromCivil(y, m, d)` / `civilFromDays(n)` implementing Howard Hinnant's civil-calendar algorithms (days since 1970-01-01).
- `isISODate(v)`: string matching `^\d{4}-\d{2}-\d{2}$` **and** round-trips through the civil conversion (rejects `2026-02-30`, `2026-13-01`). `isISOMonth(v)`: `YYYY-MM` with month 1–12.
- `toDayNumber(iso)`, `fromDayNumber(n)`, `addDays(iso, n)`, `diffDays(a, b)` (positive when `b` is later).
- `weekdayIndex(iso)`: Monday = 0 … Sunday = 6 (1970-01-01 was a Thursday, so `(((days + 3) % 7) + 7) % 7`).
- `monthOf(iso)`, `addMonths(month, delta)` (handles year rollover both ways), `monthStart`, `monthEnd`, `daysInMonth`.
- `shiftMonths(iso, delta)`: same day-of-month in another month, **clamped** to that month's last day (31 Jan + 1 month → 28/29 Feb).
- `monthsBetween(a, b)`: every `'YYYY-MM'` from `monthOf(a)` to `monthOf(b)` inclusive.
- `todayISO(timeZone = FARM_TIME_ZONE)`: `Intl.DateTimeFormat('en-CA', { timeZone, year, month:'2-digit', day:'2-digit' }).formatToParts(new Date())`.
- Formatting (English, fixed):
  - `formatDisplay` → `12/10/2026` (field value)
  - `formatShort` → `Sat 12 Oct` (summary; weekday and month cut to 3 letters, day without leading zero)
  - `formatLong` → `Saturday, 12 October 2026` (screen readers)
  - `formatMonthTitle('2026-10')` → `October 2026`
  - `nightsLabel(n)` → `1 night` / `2 nights`

---

## 4. `lodge-date-rules.js` (pure rules)

### Vocabulary

A stay is a check-in date and a check-out date. **Nights** are the dates from check-in up to, *not including*, check-out.

Availability states (from the API, per date):

| State | Meaning | May start a stay | May end a stay |
| --- | --- | --- | --- |
| `available` | night before and night of are both free | yes | yes |
| `checkin-only` | night before is taken | yes | no |
| `checkout-only` | night of this date is taken | no | yes |
| `booked` | inside someone else's stay | no | no |

Plus two **derived** states the API never sends: `disabled` (past, outside the window, blackout) and `unknown` (availability not loaded, failed, or the map doesn't mention it). **Unknown is never selectable and never assumed available.** The API is the source of truth for same-day turnover; nothing invents it.

### API

- `AVAILABILITY_STATES = ['available','booked','checkin-only','checkout-only']`.
- `normalizeAvailability(raw)`: accepts a ready-made map `{ 'YYYY-MM-DD': state }` **or** rows `[{ date, status }]` (also tolerates `state` in place of `status`). Drops rows with an invalid date format or unrecognised status (they become `unknown`, so unselectable, not silently available). Returns a plain map.
- `calculateNights(start, end)` = `diffDays`.
- `getMinimumNights(rules, start)` / `getMaximumNights(rules, start)`: `minNights` / `maxNights` may be a number **or** `(startDate) => number`. A value that isn't a finite number ≥ 1 falls back to `1` (min) / `Infinity` (max); floor fractional values.
- `getDateState(iso, rules)` with `rules = { minDate, maxDate, blackoutDates (array or Set), availability }`:
  1. `iso < minDate || iso > maxDate` → `disabled` (min and max days themselves are allowed)
  2. in blackout → `disabled`
  3. `availability == null` (no source configured) → `available`
  4. else the mapped state, or `unknown` if absent/unrecognised
- `canStartOn(state)`: `available | checkin-only`. `canEndOn(state)`: `available | checkout-only`.
- `validateRange(start, end, rules)` → `{ ok: true, nights }` or `{ ok: false, code, reason }`. **Order matters:**
  1. `end === start` → `same-day` "Check-out must be after check-in."
  2. `end < start` → `end-before-start` (same message)
  3. either end `unknown` → `unknown` "Availability isn't known for these dates yet."
  4. start `checkout-only` → `start-checkout-only` "This date is available for check-out only."
  5. start not startable → `start-unavailable` "That check-in date isn't available."
  6. end `checkin-only` → `end-checkin-only` "This date is available for check-in only."
  7. end not endable → `end-unavailable` "That check-out date isn't available."
  8. nights < min → `min-nights` "Minimum stay is N night(s)."; nights > max → `max-nights` "Maximum stay is N night(s)."
  9. every date **strictly between** start and end must be `available`: `unknown` → `unknown` "Availability isn't known for every night of this stay yet."; `disabled` → `unavailable-night` "This stay includes an unavailable date."; any other (booked, check-in-only, check-out-only) → `booked-night` "This stay includes a booked night."
- Single date:
  - `getSingleDateState(iso, rules)`: `checkin-only` and `checkout-only` **collapse to `available`** (they describe stay edges and mean nothing for one day). Everything else as `getDateState`.
  - `validateDate(iso, rules)` → `{ ok: true }` or `{ ok:false, code, reason }`: `booked` → `date-booked` "That date is unavailable."; `unknown` → `unknown` "Availability isn't known for this date yet."; else `date-unavailable` "That date is unavailable." The wording is **never "booked"** for a single date. The two codes stay separate only so the picker can tell a taken date (explains itself when clicked) from a disabled one (inert).
- `formatSummary(start, end)` → `Sat 12 Oct → Mon 14 Oct · 2 nights`.
- `thisWeekend(today)` → Friday → Sunday (2 nights). Let `day = weekdayIndex(today)` (Mon 0 … Sun 6):
  - `day === 5` (Saturday): `{ start: today, end: today + 1 }`, that night only (Sat → Sun).
  - otherwise `start = today + (day === 6 ? 5 : 4 - day)` and `end = start + 2`. Monday to Friday → this week's Friday (on a Friday, `start` is today); Sunday → the coming Friday, because the weekend is over.
  - The result still goes through `validateRange`, so a stay rule ("weekends need 2 nights") can reject it with a reason.
  - With the tests' fixed today (Mon 2026-10-12) it resolves to Fri 16 → Sun 18 Oct.

---

## 5. `DateRangePicker.astro` (the shell)

### Props (`Astro.props`)

```ts
interface Props {
  mode?: 'range' | 'single';          // default 'range'; DatePicker passes 'single'
  label?: string; ariaLabel?: string; // one is required for an accessible name
  id?: string;                        // lands on the FIELD button; default `drp-${random}`
  name?: string;                      // hidden input name
  placeholder?: string;               // 'Select check-in and check-out' | 'Select a date'
  help?: string; error?: string;      // error = message + puts field in invalid state
  value?: DateRange | string | null; defaultValue?: DateRange | string | null;
  disabled?: boolean;
  minDate?: string; maxDate?: string; // 'YYYY-MM-DD'; default today … today+365 days
  minNights?: number; maxNights?: number; // numbers only here; functions via setRules()
  blackoutDates?: string[];
  presets?: { label: string; range: {start,end} | 'this-weekend' }[]; // ignored in single
  class?: string;
}
```

Everything not consumed by the shell (`...config`) plus `mode`, `presets` (forced `[]` in single mode), `value`, `placeholder`, `error`, `disabled` is serialised to `data-config` via `JSON.stringify(...).replace(/</g, '\\u003c')` (prevents `</script>`-style breakage).

### Markup (in this order)

```
<div class="date-range [date-range--single] {class}" data-date-range data-config="…">
  <label class="form-label" id="{id}-label" for="{id}">…</label>            (only if label)
  <div class="date-range__anchor">
    <button type="button" class="form-control date-range__field" id="{id}"
            aria-haspopup="dialog" aria-expanded="false" aria-controls="{id}-panel"
            aria-labelledby="{id}-label {id}-value"   (if label)   |  aria-label={ariaLabel ?? placeholder} (if no label)
            aria-describedby={help id} data-describedby={help id} [disabled]>
      <span class="date-range__value is-placeholder" id="{id}-value">{placeholder}</span>
      <Icon name="calendar_month" size={24} class="date-range__icon" />
    </button>
    <div class="date-range__panel" id="{id}-panel" role="dialog" aria-label={title} tabindex="-1" hidden>
      <div class="date-range__bar">                                          (visible only on mobile sheet)
        <span class="date-range__title" aria-hidden="true">{title}</span>
        <IconButton icon="close" label="Close calendar" variant="plain" class="date-range__close" />
      </div>
      <div class="date-range__body">
        <div class="date-range__months">
          <IconButton icon="chevron_left"  label="Previous month" variant="plain" class="date-range__nav date-range__prev" />
          <IconButton icon="chevron_right" label="Next month"     variant="plain" class="date-range__nav date-range__next" />
          <div class="date-range__panes" data-dr-panes></div>
        </div>
        <p class="date-range__message" role="alert" data-dr-message></p>
        <ul class="date-range__legend list-unstyled small" aria-label="Calendar key">
          range only: <li><Icon login 16/> Check-in only</li>  <li><Icon logout 16/> Check-out only</li>
          both:       <li><span class="date-range__legend-booked">12</span> {single ? 'Unavailable' : 'Booked'}</li>
        </ul>
      </div>
      range only:
      <div class="date-range__footer">
        <p class="date-range__summary" data-dr-summary>Select check-in date</p>
        <div class="date-range__actions">
          {presets → <Button variant="text" class="date-range__preset" data-dr-preset={i}>}
          <Button variant="text"    class="date-range__clear" data-dr-clear disabled>Clear</Button>
          <Button variant="primary" class="date-range__apply" data-dr-apply disabled>Apply</Button>
        </div>
      </div>
      <div class="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-dr-live></div>
    </div>
  </div>
  <div class="invalid-feedback" id="{id}-feedback">{error}</div>
  {help && <div class="form-text" id="{id}-help">{help}</div>}
  <input type="hidden" name={name} value={range ? 'start/end' : single ? 'YYYY-MM-DD' : ''} data-dr-hidden />
</div>
<script> import { initDateRangePickers } from '../scripts/date-range-picker.js'; initDateRangePickers(); </script>
```

- `title = label ?? ariaLabel ?? 'Select dates'`.
- The field is a **button styled as `.form-control`**, not an `<input>`, since the value is composed and the field opens a dialog.
- The hidden input value is the **ISO-8601 interval** `2026-10-12/2026-10-14` for a range, the bare `YYYY-MM-DD` for single, and `''` when nothing is selected.
- The panel does **not** carry the `.dropdown-menu` class. Bootstrap's global dropdown key handler listens on every `.dropdown-menu` and throws without a toggle. The SCSS `@extend`s it instead so surface, border, radius and shadow are Bootstrap's own.
- `DatePicker.astro` declares its own narrower `Props` (no `minNights`, `maxNights`, `presets`) and renders `<DateRangePicker mode="single" {...Astro.props} />`.

---

## 6. Controller (`date-range-picker.js`): behaviour spec

`export class DateRangePicker` with `static instances = new WeakMap()`, `static get(el)` (accepts the root **or any element inside it**, since `id` is on the field; creates lazily), `static init(scope = document)`. Exports `initDateRangePickers(scope)` and `getDateRangePicker(el)`.

### Constants

`DESKTOP_QUERY '(min-width: 768px)'` (Bootstrap `md`), `HOVER_QUERY '(hover: hover)'`, `WINDOW_DAYS 365`, `EDGE_GAP 8`, `TOAST '.toast-container'`.

Labels: `loadError "Couldn't load availability"`, `retry "Retry"`, `checking "Checking availability…"`, `pickStart "Select check-in date"`, `pickDate "Select a date"`, `pickEnd "Select check-out"`, `booked "That date is booked."`, `checkoutOnly "This date is available for check-out only."`, `sameDay "Check-out must be after check-in."`, `unresolvable "Couldn't check availability for this stay. Retry loading, then try again."`

Screen-reader state words: `available`, `booked`, `check-in only`, `check-out only`, `disabled → "unavailable"`, `unknown → "availability unknown"`. Marker icons: `checkin-only → login`, `checkout-only → logout`. Not selectable: `disabled`, `booked`, `unknown`.

Runtime icons use the same markup as `Icon.astro` (`<span class="material-symbols-outlined" aria-hidden="true" style="--icon-size: Npx; font-variation-settings: 'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' max(N,20)">name</span>`).

### State (kept apart on purpose)

| State | Meaning |
| --- | --- |
| value | the hidden input, single source of truth |
| `draft` | `{start, end}` being edited while open; discarded on close |
| `phase` | derived: `idle` → `selectingEnd` → `rangeSelected` (single: `idle` → `dateSelected`); mirrored to `data-phase` on root |
| `hoverDate` / `previewEnd` | valid hover/keyboard range, drawn dashed, never touches the value |
| `message` | why the last attempt was rejected |
| `months` | `Map('YYYY-MM' → {state: loading\|ready\|error, token, data, error, promise})`; root gets `data-state = error \| loading \| ready` |
| `token` | bumped on every new selection action / open / close so a slow async check can't land late |
| `today` | `todayISO(FARM_TIME_ZONE)`, overridable via `setRules({ today })` |

Config (`ctx()`, cached, invalidated on rule/source/availability change): `minDate` (default today), `maxDate` (default today+365), `minNights` (default 1), `maxNights`, `blackoutDates` (Set), `availability` (the merged map of all **ready** months, or `null` when there is **no source**, in which case every in-window date is available).

### Value parsing

- Range value regex `^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$`, both ends real dates, **start < end**; otherwise treated as null. Single: any valid `isISODate`.
- `setValue(v)` normalises; invalid input clears. If the panel is open, re-derive the draft and repaint.

### Public API (`getDateRangePicker(el)`)

`getValue()` (range → `{start,end}|null`; single → string|null), `setValue(v)` (silent), `clear()` (resets draft, writes null, fires `change {value:null, reason:'clear'}` only if there was a value; panel stays open and repaints), `open()`, `close()`, `setRules({ today, minDate, maxDate, minNights, maxNights, blackoutDates })` (accepts functions for the nights; re-clamps and re-renders if open), `setSource(fn)` (`fn(month) → Promise<map | rows>`; clears month cache, hides toasts, sets availability `{}` (or `null` if fn falsy)), `setInvalid(message)` (`''` clears), `setDisabled(bool)`, `focus()`.

### Events

Bubbling `CustomEvent` on the root, named `date-range:<name>`:

| Event | detail |
| --- | --- |
| `change` | range: `{ value: {start,end}\|null, nights, reason: 'select'\|'clear' }`; single: `{ value: string\|null, reason }` (no `nights`). Only fires if the value actually changed. Not fired by `setValue()`. |
| `invalid` | `{ reason, code, start, end }`. Range only; not emitted for the two inline notices below. |
| `loaderror` | `{ month, error }` |
| `open`, `close` | `{}` |

### Field rendering

- Placeholder: `.is-placeholder` on `.date-range__value`, text = placeholder, colour `--bs-secondary-color`.
- Range value: `12/10/2026 <span aria-hidden>→</span><span class="visually-hidden">to</span> 14/10/2026`. Single: `12/10/2026`.
- Invalid: `is-invalid` on field **and** root, `aria-invalid="true"`, feedback text set, feedback id appended to `aria-describedby` (merged with the help id kept in `data-describedby`), `.invalid-feedback` forced `display: block` under `.date-range.is-invalid`.
- Disabled: `field.disabled`, root `.is-disabled`, closes the panel without restoring focus.

### Open / close

`open()`: no-op if already open or disabled. Bump token, `draft = draftFromValue()`, clear preview/message. `focusDate = clampDate(draft.start ?? today)`, `viewMonth = clampView(monthOf(focusDate))`. Show panel (`hidden=false`, class `show`), root `is-open`, `aria-expanded=true`, apply presentation, render months **restoring focus** onto the focus date, paint footer, add a capture-phase `pointerdown` outside listener, emit `open`.

`close({restoreFocus = true})`: bump token, hide panel, remove `show`/`is-end`, `aria-expanded=false`, remove listener, release overlay, **discard draft** (an uncommitted draft is not saved), clear message; focus the field if `restoreFocus`; emit `close`.

Dismissal:
- **Esc** anywhere in the root when open: `preventDefault`, `stopPropagation`, close, focus returns to the field.
- **Desktop only:** tabbing (focusout) to an element outside the root closes it **without** restoring focus. Exception: focus moving into `.toast-container` does not close.
- **Outside pointerdown** (capture): ignore clicks inside the root or inside a toast (the Retry belongs to this flow). Otherwise close without restoring focus, then on the next animation frame return focus to the field **only if** the picker had focus and `document.activeElement === document.body` (never steal focus from a control the user clicked).
- Field click toggles.
- The mobile sheet also has a Close icon button in the bar.

### Presentation (one DOM, two presentations)

- `isSheet = !matchMedia('(min-width: 768px)').matches`. Re-evaluated on `change` while open (re-render months, re-clamp view).
- **≥ md (dropdown):** panel below the field, **two months** (range) or **one** (single), hover preview, Apply hidden, commits the moment a valid check-out is chosen (or a date is picked). `alignPanel()`: remove `is-end`; if the panel's right edge exceeds `documentElement.clientWidth - 8px`, add `is-end` (right-aligned).
- **< md (sheet):** fixed full-screen modal, one month, bar with title + Close, sticky footer with summary + Apply. `aria-modal="true"`, everything outside the panel made `inert` (`inertOutside`, toast containers exempt), page scroll locked (`lockScroll`, reference-counted). Released on close and when crossing to desktop. **Nothing is committed until Apply** (range). Single mode has no footer, so a tap commits and closes on mobile too.
- `monthCount = (range && desktop) ? 2 : 1`.

### View clamping

`clampView(month)`: lowest = `monthOf(minDate)`; highest = `monthOf(maxDate) − (monthCount − 1)` months (so two panes never run past `maxDate` when the window is wide enough), never below lowest. `clampDate(iso)` clamps to first day of min month … last day of max month. Prev/next stop at the window edges.

### Availability loading

- Only months that intersect `[minDate, maxDate]` and only when a source exists ask for data.
- `load(month, {force})`: caches; returns the existing promise unless `force`. Entry `{state:'loading', token+1}`. `fetchMonth` awaits `source(month)`, ignores results if the entry was superseded, `normalizeAvailability`, state `ready`, hides that month's toast. On failure: state `error`, emit `loaderror`, show one toast per failed month. After each settle recompute the merged availability map from all ready months, invalidate ctx, re-render/re-paint footer if open. **An errored month is not retried automatically**, only by `retry(month)` (inline button or toast action), which hides the toast, force-loads, announces `Loading availability for {Month YYYY}` and leaves the **selection untouched**.
- Toast: `showToast({ body: "Couldn't load availability", theme: 'error', autoHide: false, action: { label: 'Retry', onClick }, onClose })`, tracked in a `Map` so one failure ⇒ one toast; hidden when the month later succeeds or the source changes.
- **Loading month:** a pane with `aria-busy="true"`, a visually-hidden `role="status"` "Loading availability for {Month YYYY}", and a skeleton grid (`.placeholder-glow` + `.placeholder` cells, `aria-hidden`), sized to the month's real week count. **Nothing in it is selectable.** Paging loads only the new month; loaded months remain usable.
- **Error month:** normal grid of `unknown` (inert) days plus a `role="alert"` bar: error icon, "Couldn't load availability", and an outline-primary small **Retry** button (`data-dr-retry="{month}"`).
- **No source:** no loading, every in-window date is available.

### Rendering

Each pane: `<h3 class="date-range__month h6" id="{uid}-{month}">October 2026</h3>` then `role="grid"` labelled by it. Header row of 7 `role="columnheader"` cells: visible two-letter uppercase abbreviation (`aria-hidden`) + a visually-hidden full name. Rows are `role="row"`, days are `role="gridcell"` (`.date-range__cell`, `data-cell="ISO"`) each containing one `<button type="button" class="date-range__day is-{state}[ is-today]" data-dr-day="ISO" tabindex="-1">` with the numeral in `.date-range__num` and, for check-in-only / check-out-only in range mode, a 14px marker icon (`.date-range__marker`). Leading and trailing blanks are `role="gridcell" aria-hidden="true" .date-range__blank`. Not-selectable states get `aria-disabled="true"` (**not** `disabled`, so they stay focusable and announce). Month starts on Monday (lead = `weekdayIndex(first day)`).

Rendering is split: `cellHTML` bakes in everything availability-dependent; **`paint()`** applies selection-dependent bits on every change without rebuilding the DOM:
- Cell class `is-range-start | is-range-end | is-range-mid` for a committed draft (strictly-between days are "mid"), or `is-preview-start | -end | -mid` for the preview.
- `aria-selected` on the cell (true for start, end and in-between); `.is-selected` on the button for start/end.
- Accessible name: `"{formatLong}, {parts}"` where parts, in order: `today`; then `selected as check-in` (range) / `selected` (single) for start, `selected as check-out` for end, `in your stay` for in-between; then the state word. **Single mode says "unavailable" for a taken date**, never "booked".
- Roving tabindex: only the focus date has `tabindex=0`; if it isn't on screen, the first day is the tab stop (exactly **one tab stop** in the grid).
- The panes container keeps a reserved min-height for a 6-week month so the panel doesn't jump.

Footer (`paintFooter`, range only): summary text = `Select check-in date` (idle) → `Sat 12 Oct → Select check-out` (start only) → `Sat 12 Oct → Mon 14 Oct · 2 nights` (complete). **Apply** is disabled until the draft has an end. **Clear** is enabled if there is a committed value or a draft start. Disabled state on `Button.astro` = `[disabled]` + `.disabled` + `aria-disabled`, so the helper `setButtonDisabled` must toggle all three. While checking availability for a pending check-out the summary reads `Checking availability…` and Apply is disabled.

`updateNav`: prev/next use `aria-disabled` + `.disabled` (not `disabled`) so a focused arrow keeps focus at the window edge.

### Selection: range mode

`onDay(iso)` (click, or Enter/Space via the button's own click), sets `focusDate = iso`, clears preview, then by state:

1. **`disabled` / `unknown`**: inert. Repaint and keep focus on the cell. No message.
2. **`booked`**: reject inline with "That date is booked." (`code: 'date-booked'`), **no `invalid` event**.
3. Otherwise, with `start` = current draft start:
   - If phase is not `selectingEnd`, **or** `iso < start` → **`startAt(iso)`**: an earlier date replaces the check-in, and clicking any date after a complete range starts a new selection. If the state is `checkout-only`, reject with "This date is available for check-out only." (`start-checkout-only`, no event). Otherwise `draft = {start: iso}`, clear message, repaint, focus the cell, announce `Check-in {formatLong}. Choose a check-out date.`
   - `iso === start` → reject `same-day` (emits `invalid`).
   - else → **`finishAt(iso)`**.

`finishAt(end)`: increments the token; `checkRange(start, end, token)`. First fetches every month the stay crosses that is not `ready`/`error` yet (summary shows "Checking availability…", Apply disabled, live announce), awaits them, aborts silently if the token changed or the picker closed (returns null). Then `validateRange`. If the result is `unknown` and any crossed month is in `error`, replace the reason with the `unresolvable` message. On failure: `reject({...result, start, end})` **keeps the current selection**, shows the reason inline (`role="alert"`, error icon, `--bs-danger`), keeps focus on the focus date, and emits `invalid`. On success: `draft = {start,end}`, clear preview/message, repaint, announce the summary; **desktop** → `commit(draft)` + `close()`; **sheet** → wait for Apply.

`apply()` (sheet): needs `draft.end`; commit; close.

`applyPreset(i)`: resolve `'this-weekend'` via `thisWeekend(today)` or a fixed range; go through `checkRange` and validation exactly like a manual selection (reject with reason + `invalid`); on success set draft, focus and view to the start month, re-render, announce; desktop commits and closes, sheet waits for Apply.

`commit(value)`: writes the hidden input, re-renders the field, and emits `change {…, reason:'select'}` **only if it differs** from the previous value.

A rejection message persists until the next interaction (open, navigate, new start, clear, close).

### Selection: single mode

`onDay` → `pickDate(iso)`: `validateDate`. If not ok: a taken date shows "That date is unavailable." inline (no event); `disabled` / `unknown` are inert. If ok: bump token, `draft={start:iso}`, repaint, announce `{formatLong} selected`, `commit(iso)`, `close()`, on desktop **and** sheet. No preview, no footer, no `invalid` event.

### Hover / keyboard preview

`previewFor(iso)` returns `iso` only when mode is range, a start exists with no end, `iso > start`, and `validateRange(start, iso)` is ok. So only ranges that **would be accepted** preview. Hover (only if `(hover: hover)`) via `mouseover` on the panes; `mouseleave` clears. Keyboard focus movement also previews while `selectingEnd`. Single mode never previews (its saved date lives in `draft.start` and must not look like a range in progress).

### Keyboard (grid)

Handled on the **panel** (not the grid), because while a month loads focus waits on the panel itself. Ignore events with Alt/Ctrl/Meta.

| Key | Action |
| --- | --- |
| ← / → | ∓1 day |
| ↑ / ↓ | ∓7 days |
| Home / End | start / end of the week (Monday / Sunday) |
| PageUp / PageDown | ∓1 month (`shiftMonths`, clamped day-of-month) |
| Enter / Space | the day button's own click → `onDay` |
| Esc | close, focus back to the field |
| Tab | one tab stop into the grid; Tab out closes on desktop |

`moveFocus(target)`: clamp to the window; if the target's month is off-screen, scroll the view (`monthCount`-aware), re-render restoring focus, and announce the new month title(s) joined by " and "; otherwise just repaint and focus the cell. Prev/next buttons: `navigate(±1)` clamps the view, shifts `focusDate` by a month, clears preview/message, announces the visible month(s), no focus theft.

Live region (`data-dr-live`, polite, atomic): `announce(text)` clears then sets after 120 ms so repeats are read. Announces: check-in chosen, range summary, date selected, month change, checking availability, retry loading.

---

## 7. Behavioural checklist per state (design-system state audit)

| State | Field | Calendar / day | Reason if "no" |
| --- | --- | --- | --- |
| default | yes | yes | |
| hover | no | yes | `.form-control` has no hover; days get tint + outline, hover-capable pointers only |
| focus | yes | yes | shared ochre ring; roving tabindex in grid |
| active | no | no | no distinct pressed look elsewhere in the system |
| disabled | yes (whole control) | yes (past, outside window, blackout: faded, no strike) | |
| loading | n.a. | yes (per month) | |
| skeleton | n.a. | yes | known layout ⇒ `.placeholder`, not a spinner |
| empty | yes (placeholder) | no | a month always has days |
| error | yes (invalid styling + describedby) | yes (month error + Retry + toast) | |
| success | no | no | picking is its own confirmation; no valid-styling convention here |
| selected / range / preview | n.a. | yes | filled+bold / connecting band / dashed band (never a fill) |
| today · booked · check-in only · check-out only | n.a. | yes | dot · strike-through · login icon · logout icon (none rely on colour) |

Single mode: identical minus range/preview, minus check-in/out-only, minus footer.

---

## 8. Accessibility requirements

- Field: button with `aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`, and name from `aria-labelledby="{label} {value}"` (so the chosen date is read) or `aria-label`.
- Panel: `role="dialog"` with an accessible name; `aria-modal="true"` **only** in sheet mode (with page `inert` + scroll lock).
- Calendar: `role="grid"`, labelled by the month heading; column headers with full names; **every day has a full accessible name including state** (e.g. `Sunday, 18 October 2026, selected as check-out, check-out only`).
- Unavailable/booked days remain focusable and announce their state (`aria-disabled`, not `disabled`).
- Rejections and month errors are `role="alert"`; loading months announce via `role="status"`; a shared polite live region announces selection and navigation.
- Every state has a **non-colour cue**: selected = filled + bold; range = connecting band; preview = dashed edges; today = dot; booked = strike-through + muted; disabled = faded (no strike); check-in/out only = icon.
- Days are 44 px (`2.75rem`) touch targets; no hover-only information.
- Visible focus on everything (`$focus-ring-box-shadow`); a focused selected day keeps its ring.
- `prefers-reduced-motion: reduce` disables the skeleton glow animation. Nothing else animates.

---

## 9. Styles (`src/styles/main.scss`, one `.date-range` block, placed before the Palm Spinner block)

Tokens/vars: `$dr-cell: 2.75rem`, `$dr-panel-width: 42rem`. On `.date-range`: `--dr-safe-{top,right,bottom,left}: env(safe-area-inset-*, 0px)`, `--dr-band: rgb(var(--bs-primary-rgb), .1)`, `--dr-hover: rgb(var(--bs-primary-rgb), .06)`, `--dr-line: var(--bs-primary)`; `position: relative`. `.date-range [hidden] { display: none !important }`.

- **Field:** flex, space-between, `text-align: start`, pointer cursor; `is-invalid`/`is-valid` reset the padding and drop Bootstrap's validation background icon (it would sit under the calendar icon); `:disabled` → `not-allowed`; `.is-open` field (not invalid) gets `$input-focus-border-color`. `.date-range__value` `min-width: 0`; placeholder colour `--bs-secondary-color`. Calendar icon `--bs-secondary-color`, `flex: 0 0 auto`.
- **Panel:** `@extend .dropdown-menu` (with the stylelint-disable comment for `scss/at-extend-no-missing-placeholder`), `top: 100%; left: 0; width: min(42rem, calc(100vw - 2rem)); margin-top: .125rem; padding: 0`; `.show` → `display: flex; flex-direction: column`; `.is-end` → `right: 0; left: auto`.
- **Bar:** `display: none` (only on mobile), flex, space-between, bottom border in `--bs-border-color`. Title: serif, `$h5-font-size`, 700.
- **Body:** `flex: 1 1 auto; min-height: 0; padding: 1rem 1rem 0; overflow-y: auto; overscroll-behavior: contain`.
- **Months:** nav buttons absolutely positioned top-left / top-right, `z-index: 1`. Panes: grid, 1 column (`minmax(0,1fr)`), `gap: 1.5rem 2rem`, `min-height: calc(2.75rem * 5.65)`; `[data-count='2']` → 2 columns. Month heading centred with `line-height: 2.75rem`. Weekday header: `$small-font-size`, 600, uppercase, centred, `--bs-secondary-color`. Rows and skeleton: 7-column grid. Skeleton cell: centred, height 2.75rem, `.placeholder` 55% × 1.25rem.
- **Cell (carries the band):** `is-range-mid` = `--dr-band`; `is-range-start` = `linear-gradient(to right, transparent 50%, var(--dr-band) 50%)`; `is-range-end` = mirrored. Preview: two dashed 1px lines (top and bottom) built with `repeating-linear-gradient(to right, var(--dr-line) 0 4px, transparent 4px 8px)`, `background-size: 100% 1px` (start/end halves are `50% 1px`, start right-aligned) so it can never be mistaken for a committed range.
- **Day button (carries the fill):** flex column, centred, full width, `min-height: 2.75rem`, no border, `border-radius: var(--bs-border-radius)`, transparent, inherit colour and font, `line-height: 1`. `:focus-visible` → z-index 1, no outline, `$focus-ring-box-shadow`. Hover **only inside `@media (hover: hover)`** and not on `[aria-disabled='true']`: `--dr-hover` background + `inset 0 0 0 1px var(--bs-primary)`. `.is-today::before` = 4px dot, top `.3125rem`, `currentcolor`, pill radius. `.is-disabled, .is-unknown` = `opacity: .35`, `not-allowed`. `.is-booked` = `--bs-ink-faint` + `line-through` on `.date-range__num`, `not-allowed`. `.is-selected` (also on hover) = `--bs-primary` background, `--bs-body-bg` text, 700, no shadow; keeps the focus ring on `:focus-visible`. Marker icon absolutely positioned at `bottom: .125rem`.
- **Messages:** `.date-range__message` flex, `gap: .5rem`, `margin: .5rem 0 0`, `--bs-danger`, `:empty { margin: 0 }`. `.date-range__error`: flex-wrap, `border-left: .25rem solid --bs-danger`, `rgb(var(--bs-danger-rgb), .08)` background, danger text.
- **Legend:** flex-wrap, `gap: .25rem 1rem`, `margin: 1rem 0`, `--bs-secondary-color`; booked sample `--bs-ink-faint` + line-through.
- **Footer:** column, `gap: .5rem`, `padding: .75rem 1rem`, top border in `--bs-border-color`. `.date-range__summary`: `margin: 0; font-weight: 600; color: var(--bs-heading-color)` (**not** `emphasis-color`, which is pure black here). Actions: flex-wrap, `gap: .5rem`. `.date-range__apply { display: none }` on desktop.
- **`@include media-breakpoint-up(md)`:** single-mode panel width `min(22rem, calc(100vw - 2rem))`; footer becomes a row (space-between, centred); actions right-aligned.
- **`@include media-breakpoint-down(md)` (sheet):** panel `position: fixed; inset: 0; z-index: $zindex-modal; width: auto; height: 100vh then 100dvh; margin: 0; padding: safe-top safe-right 0 safe-left; no border, radius or shadow; background-color: var(--bs-body-bg)`. Show the bar. Footer bottom padding `calc(.75rem + var(--dr-safe-bottom))`; single body bottom padding `calc(1rem + safe-bottom)`. Preset/Clear text buttons: `padding-inline: .5rem; white-space: nowrap`. Apply: `display: inline-flex; flex: 1 1 auto; margin-left: auto` (wraps to its own row on the narrowest phones).
- **`@media (prefers-reduced-motion: reduce)`:** `.date-range .placeholder-glow .placeholder { animation: none }`.
- `.date-range--single .date-range__body { padding-bottom: 1rem }` (no footer closes the panel).
- Also required elsewhere in `main.scss`: `.scroll-lock { overflow: hidden; overscroll-behavior: contain }` (shared with Autocomplete) and `ink-faint` present in the theme colour map so `--bs-ink-faint` exists.
- Run `npm run lint:css`; no raw colours, no one-off px spacing beyond what is documented above.

---

## 10. `dom-overlay.js`

- `lockScroll()` / `unlockScroll()`: reference-counted; adds/removes `.scroll-lock` on `document.documentElement` when the count goes 0↔1, so two overlays can't unlock each other.
- `inertOutside(el)`: walks from `el` up to the root, setting `inert = true` on every sibling that isn't `el`'s ancestor chain, isn't already inert, and isn't a `.toast-container`; returns a function that undoes exactly those changes. (Autocomplete's mobile search also uses these; if refactoring it, keep behaviour identical.)

---

## 11. Tests (`node --test`, `package.json` script `"test": "node --test"`)

Use `node:test` + `node:assert/strict`. Fixed "today" = **Monday 2026-10-12**, window today → +365.

`date-only.test.js`: `isISODate` accepts only real dates (leap day 2028-02-29 yes, 2026-02-29 no, 2026-13-01 no); `addDays` across month, year and leap-day boundaries; `diffDays`; `weekdayIndex` Monday-first (2026-10-12 → 0, 2026-10-18 → 6); month helpers (`addMonths` both directions, `daysInMonth`, `shiftMonths` clamping 31 Jan → 28/29 Feb, `monthsBetween`); formatting.

`lodge-date-rules.test.js` (one `test` per bullet): `calculateNights`; summary text `Sat 17 Oct → Mon 19 Oct · 2 nights`; past dates disabled; `minDate` and `maxDate` themselves allowed; blackout (array **and** Set) disabled; a blackout inside a stay rejects it; available is startable and endable; booked is neither; check-in-only only starts; check-out-only only ends; **same-day turnover** (a check-out-only end and a check-in-only start on one date); dates missing from the map are `unknown`, never available; with `availability: null` in-window dates are available; adapter normalises maps and rows and drops junk; same-day and end-before-start rejected; min nights; max nights; min nights as a function of start ("weekends need 2"); max nights as a function; nonsense night rules fall back to 1 / unlimited; a booked night inside rejects the whole range; check-in-only/check-out-only inside a stay also rejects; an unknown date inside rejects; `thisWeekend` on a weekday, Saturday, Sunday; the preset still fails the normal rules; **single date**: available selectable, taken rejected as "unavailable" never "booked", check-in/out-only count as available, past / outside window / blackout unavailable, missing-from-map unknown.

All tests must pass with `npm test`. Also run `npm run lint` and `npm run check`.

---

## 12. Design-system page (`src/pages/design-system/index.astro`)

Add two nav entries (`['date-range-picker','Date Range Picker']`, `['date-picker','Date Picker']`) and two `<section class="pb-6 mb-6 border-bottom">` blocks, each with: intro paragraph (with status: experimental), live examples, an event-log line, State audit, Props table, Script API, Events, Behaviour list. Match the existing sections' markup.

**Date Range Picker examples**
1. *Stay dates (availability, stay rules, preset)*: `id="ds-drp-default" name="stay" label="Stay dates"` with the `This weekend` preset and help "Fri / Sat / Sun check-ins need 2 nights. Maximum 14 nights."; plus two checkboxes: "Fail the next availability load" (`#ds-drp-fail`; one-shot, resets itself) and "Slow availability (3s): shows the skeleton" (`#ds-drp-slow`).
2. *With a value (set from outside, no event)*: `ds-drp-value`, `name="stay-set"`.
3. *Error*: `error="Please choose your check-in and check-out dates."`.
4. *Disabled*.
5. *No availability source*: `minNights={2}` + preset.

**Date Picker examples:** 1 Date (availability source; shares the toggles above), 2 With a value, 3 Error ("Please choose a date."), 4 Disabled, 5 No source with a custom window (`minDate` today+3, `maxDate` today+45, one blackout day at today+10, all via `setRules`).

**Demo script (bottom `<script>`):**
- Fake availability API derived from **booked nights**: build `drpBookedNights` (45 clusters, cluster `k` starts at day `4 + k*9 + (k%3)`, lasting `2 + (k%3)` nights). A date's state follows its two neighbouring nights: night-before taken + night-of taken → `booked`; night-of taken only → `checkout-only`; night-before taken only → `checkin-only`; neither → `available`. `drpSource(month)` resolves a full-month map after 500 ms (3000 ms when the slow checkbox is ticked); when the fail checkbox is ticked it un-ticks itself and rejects with `new Error('Simulated failure')`.
- Rules for examples 1–3: `setSource(drpSource)` + `setRules({ maxNights: 14, minNights: (start) => weekdayIndex(start) >= 4 ? 2 : 1 })` (the function-valued weekend rule shows why `setRules` exists).
- Example 2: set the first 2-night stay (start day 1…99) that `validateRange` accepts against the fake data. Date Picker example 2: first date after tomorrow that `validateDate` accepts.
- One delegated listener per event name (`change`, `invalid`, `loaderror`, `open`, `close`) writing `"{fieldId} · {name} {JSON detail}"` to the right log (`.date-range--single` → Date Picker log; serialise `loaderror`'s `error` as `String(error.message)`).

**Documentation content to include (must match behaviour):** props tables from §5 (with defaults), script API, events table, and Behaviour bullets: Responsive; Selection (idle → selectingEnd → rangeSelected; earlier date replaces check-in; same day rejected; a date after a complete range starts anew; Clear resets, sets null, fires change, panel stays open); Rules; Availability (per month, cached; skeleton; paging loads only the new month; error = inline Retry + toast, one per month, selection kept); Keys; Accessibility; Dates (plain strings, integer arithmetic, only "today" reads a clock, `Asia/Muscat`). For Date Picker also document: no footer at any size so a pick commits and closes; "unavailable" wording; check-in/out-only count as available; `clear()` exists but there is no Clear button, and no `invalid` event.

---

## 13. Edge cases you must handle (each is a regression risk)

- Slow response for a month arrives **after** the user changed selection, closed, or changed source ⇒ the entry/token check discards it.
- User clicks a check-out that crosses an **unloaded month** ⇒ fetch first, show "Checking availability…", validate after; if that month **failed**, reject with the `unresolvable` message and leave the selection.
- A check-out across a **booked night**, blackout, check-in-only/out-only date, or an unloaded night ⇒ whole stay rejected with the specific reason.
- Same-day turnover: one stay may end on a date the API marks `checkout-only` while another starts on a `checkin-only` date. The component only honours what the API reports and never invents turnover.
- `minDate`/`maxDate` inside a month: days outside are disabled; nav stops at the window; two-month view never scrolls past `maxDate` when the window is wide enough.
- Jan 31 + PageDown lands on Feb 28/29 (clamp); year rollover Dec → Jan works both ways.
- `setValue` with an invalid string/range (`start >= end`, `2026-02-30`) clears rather than throws. `setValue` never emits `change`.
- Resizing across the `md` breakpoint while open: re-apply presentation (release/attach inert + scroll lock), re-clamp, re-render, keep the draft.
- Panel would overflow the viewport on the right ⇒ `is-end` right-aligns it.
- Only one scroll-lock owner at a time (ref-counted); `close()` always releases inert and scroll lock, including via `setDisabled(true)`.
- Focus: opening focuses the selected date or today (clamped); a closed picker returns focus to the field except on outside click / Tab-out; never steal focus from another control.
- Clicking a toast's Retry while the dropdown is open must not close it.
- `is-invalid` field must not also show Bootstrap's validation icon.
- Missing/empty content: no label ⇒ `aria-label` from `ariaLabel` or the placeholder; no help ⇒ no `aria-describedby` unless invalid; long placeholders don't overflow (`min-width: 0`); `error` prop renders the invalid state on load.
- Multiple pickers per page: unique `uid` per instance so heading ids don't collide; `id` prop defaults to a random `drp-…` value.
- Serialised config must escape `<`.
- Hidden `[hidden]` elements inside `.date-range` stay hidden even against Bootstrap display utilities (`!important` rule).

---

## 14. Acceptance criteria (verify before you finish)

1. `npm test` passes; `npm run lint` and `npm run check` pass; `npm run build` succeeds.
2. `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|\b(white|black)\b'` over the new SCSS block and both components finds nothing (except tokens-with-alpha).
3. Desktop (≥768 px) in a real browser: two-month dropdown; hover previews a dashed band only for valid ends; clicking a valid check-out commits and closes; Esc closes and refocuses the field; Tab out closes; Apply is hidden.
4. Mobile (<768 px): full-screen sheet, one month, close button, sticky summary + Apply (disabled until a complete valid range), nothing committed before Apply, page scroll locked and background inert, safe-area padding respected.
5. Availability: skeleton on first load; per-month loading on paging; forced failure shows inline error + toast, **Retry** recovers without losing the selection; slow mode (3s) shows the skeleton; booked days struck through and announce "booked" (range) / "unavailable" (single); check-in-only / check-out-only days show login/logout icons and reject the wrong end with the exact message.
6. Keyboard-only: full operation via arrows, Home/End, PageUp/PageDown, Enter/Space, Esc; a single tab stop in the grid; visible focus everywhere.
7. Screen reader: every day announces date + state; rejections and errors are alerts; selection/month changes are announced.
8. Single mode: one-month dropdown (22 rem), no footer, pick = commit + close on desktop **and** mobile, `change` detail `{ value, reason }`, hidden input holds the bare `YYYY-MM-DD`.
9. Design-system page shows every example and state; the event log updates; the state audit, props, API, events and behaviour text match the implementation.
10. Reduced-motion: skeleton glow stops. No layout shift when paging between months (reserved min-height).

Work in this order: `date-only.js` + tests → `lodge-date-rules.js` + tests → `dom-overlay.js` → `DateRangePicker.astro` → controller → SCSS → `DatePicker.astro` → design-system page. Do not build anything beyond this spec. If a token or behaviour is missing, ask rather than invent.
