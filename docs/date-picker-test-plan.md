# DatePicker — test plan

What proves the spec (section numbers refer to the DatePicker spec, cited in
the source as `§n`) and where it runs.

| Layer | Command | Covers |
| --- | --- | --- |
| Unit | `npm test` | `date-only.test.js`: leap years (2028-02-29 valid, 2026-02-29 invalid, 2100 not leap), month/year rollover, last-day clamping (31 Jan + 1 month → 28/29 Feb), weekday, day-number round-trips, `todayISO()`. `date-picker-logic.test.js`: availability states, `getSingleDateState`/`validateDate`, wording (never "booked"), grid building, keyboard targets, window clamping, placement geometry (below / flip above / shrink / hysteresis / safe-area / header inset), tap-vs-drag detection. |
| Browser (emulated) | `npm run test:e2e` | `e2e/date-picker.e2e.mjs` — starts its own `astro dev` on port 4599 (`E2E_PORT` to change) and drives Chromium via `playwright-core`. Uses the design-system page and the Component Testing page's DatePicker scenarios (C1–C4). |
| Manual, real devices | below | Anything emulation cannot reproduce. |

## Automated browser matrix

Devices (in `e2e/helpers.mjs`): iPhone SE 320×568, 375×667, Pixel 412×915, and
landscape 568×320 / 667×375, all `isMobile` + `hasTouch`.

| Scenario | Device(s) | Assertion |
| --- | --- | --- |
| Select on tap | 375 | commits immediately, closes, focus back on field, events `open → change → close` |
| Keyboard | desktop | one tab stop; ↑↓ ±7, PageDown, End = Sunday, Esc restores focus |
| Booked / unknown / disabled taps | desktop | inline "That date is unavailable." (role=alert), no event, label never says "booked" |
| `error` prop | desktop | `aria-invalid`, `aria-describedby` = help + feedback, Bootstrap icon suppressed, clears on select |
| Loading / error / Retry | 375 | skeleton + `aria-busy` + status text, no spinner, inline error (no toast), manual Retry |
| Stale response | desktop | a superseded source's late answer is discarded |
| Panel inside viewport, cells ≥ 36 px | 320, 375, Pixel | width = `min(22rem, 100vw − 2rem)`, no horizontal page scroll |
| Field at page bottom | 375 | flips above, document height unchanged |
| Short landscape | 568×320 | `max-height` + internal scroll, sticky header stays put, compact cells |
| Rotation while open | 375 ↔ 667×375 | stays open; month, focus date, draft unchanged; still inside viewport |
| Shrinking viewport (keyboard) | Pixel | CDP `Emulation.setDeviceMetricsOverride` 915 → 600 → 460 → 915; re-placed inside each height, stays open |
| Fixed site header | desktop | panel never starts above the header's bottom edge |
| Outside tap vs. scroll | desktop, Pixel | > 10 px drag, wheel and a touch scroll gesture do **not** close; a tap on a focusable control closes and leaves focus there |
| Tab-out | Pixel | closes, focus not restored to the field |
| Multiple instances | desktop | opening B closes A; no duplicate ids on the page |
| Disable while open | desktop | closes, focus not restored |
| Plain modal | 375 | not clipped, nothing paints above it, Esc closes only the picker, second Esc closes the modal |
| Text input focused while open | desktop | picker closes, focus stays on the input |
| Backdrop tap | desktop | closes only the picker; modal survives that tap, second tap dismisses it |
| Scrollable modal | 375 | panel keeps its anchor to the field while `.modal-body` scrolls; never clipped |
| `hide.bs.modal` / offcanvas | desktop, 375 | closes without restoring focus; Esc closes only the picker |

## Manual checks on real devices

Emulation cannot reproduce the software keyboard or the iOS visual viewport, so
run these on a **real iPhone (Safari)** and a **real Android phone (Chrome)**:

1. **Keyboard already up.** Focus a text input on the Component Testing page (C1), then tap the date
   field. Panel must place inside the *visible* area, not behind the keyboard; no jitter for ~0.5 s.
2. **Keyboard appears while open.** Open the picker, then tap the text input beside it. Picker closes
   and focus stays on the input.
3. **Keyboard dismisses on open.** Same as 1, but watch that the panel settles in the final position
   after the viewport grows back.
4. **Pinch-zoom.** Zoom in, open the picker, pan. Panel stays next to the field and inside the visual
   viewport; closing/reopening while zoomed lands correctly.
5. **Address-bar collapse.** Scroll the page with the picker open (the bar collapses/expands): panel
   follows the field, does not close, does not flicker between above/below.
6. **Rotation.** Rotate both ways while open, on a page and inside the modal (C1/C2): stays open, same
   month/focus, re-clamped, notch/safe-area respected on the leading and trailing edges.
7. **Scroll vs. tap.** With the picker open, flick-scroll the page with a finger: must not close.
   Then tap empty page space: closes without moving focus anywhere.
8. **Backdrop tap in a modal.** Tap the dimmed backdrop with the picker open: picker closes, modal
   stays; tap again: modal closes.
9. **Screen reader.** VoiceOver (iOS) and TalkBack: field announces label + value; day cells announce
   "Saturday, 12 October 2026, selected, available" / "…, unavailable"; selection, month changes and
   "Loading availability for …" are spoken; the load error and the booked-day message are announced
   as alerts.
10. **320 px wide device** (or iPhone SE): every day is tappable without mis-taps.

Record device, OS/browser version and result for each in the PR.
