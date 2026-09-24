// Browser tests for DatePicker (spec §14 "Positioning / mobile" and
// "Behavior"). Emulated devices only — see docs/date-picker-test-plan.md for
// what must still be checked by hand on real iOS Safari / Android Chrome.
//   npm run test:e2e
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICES, PAGES, insideViewport, isOpen, launch, openPage, openPicker, panelBox, scrollFieldToBottom, startServer,
} from './helpers.mjs';

let stopServer;
let browser;
before(async () => {
  stopServer = await startServer();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  stopServer?.();
});

const pageOf = (device, url = PAGES.componentTesting) => openPage(browser, device, url);
const collect = (page) => page.evaluate(() => {
  window.__dpEvents = [];
  ['change', 'open', 'close', 'invalid'].forEach((n) => document.addEventListener(`dp:${n}`, (e) => window.__dpEvents.push({ n, id: e.target.id, d: e.detail })));
});
const events = (page) => page.evaluate(() => window.__dpEvents);

const cleanly = async (page, fn) => {
  try { await fn(); } finally {
    assert.deepEqual(page.errors, [], 'no uncaught page errors');
    await page.context().close();
  }
};

describe('selection & focus', () => {
  it('opens on tap, selects a day, commits immediately and returns focus to the field', async () => {
    const page = await pageOf(DEVICES.iphone375);
    await cleanly(page, async () => {
      await collect(page);
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      assert.equal(await page.getAttribute('#mt-dp-page-a .dp__field', 'aria-expanded'), 'true');
      const target = page.locator('#mt-dp-page-a .dp__day--available').nth(2);
      const iso = await target.getAttribute('data-date');
      await target.click();
      assert.equal(await isOpen(page, 'mt-dp-page-a'), false);
      assert.equal(await page.inputValue('#mt-dp-page-a [data-dp-hidden]'), iso);
      assert.equal(await page.getAttribute('#mt-dp-page-a .dp__field', 'aria-expanded'), null);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'mt-dp-page-a-field');
      const names = (await events(page)).map((e) => e.n);
      assert.deepEqual(names, ['open', 'change', 'close']);
      assert.deepEqual((await events(page))[1].d, { value: iso, reason: 'select' });
    });
  });

  it('keeps exactly one tab stop in the grid and follows the keyboard spec', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      const stops = () => page.locator('#mt-dp-page-a .dp__day[tabindex="0"]').count();
      assert.equal(await stops(), 1);
      const focused = () => page.evaluate(() => document.activeElement.dataset.date);
      const start = await focused();
      await page.keyboard.press('ArrowDown');
      const down = await focused();
      assert.ok(down > start);
      await page.keyboard.press('ArrowUp');
      assert.equal(await focused(), start);
      await page.keyboard.press('PageDown');
      assert.equal((await focused()).slice(0, 7) > start.slice(0, 7), true);
      assert.equal(await stops(), 1);
      await page.keyboard.press('End');
      const end = await focused();
      const sunday = await page.evaluate(async (iso) => {
        const { weekdayIndex } = await import('/src/scripts/date-only.js');
        return weekdayIndex(iso);
      }, end);
      assert.equal(sunday, 6);
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page, 'mt-dp-page-a'), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'mt-dp-page-a-field');
    });
  });

  it('booked days are rejected inline without an event; disabled days are inert', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      await collect(page);
      await page.locator('#ds-dp-source').scrollIntoViewIfNeeded();
      await openPicker(page, 'ds-dp-source');
      await page.waitForSelector('#ds-dp-source .dp__month[aria-busy="false"]', { timeout: 5000 });
      const booked = page.locator('#ds-dp-source .dp__day--booked').first();
      await booked.click({ force: true }); // aria-disabled buttons read as not-enabled to Playwright
      assert.equal(await page.textContent('#ds-dp-source [data-dp-message]'), 'That date is unavailable.');
      assert.equal(await page.getAttribute('#ds-dp-source [data-dp-message]', 'role'), 'alert');
      assert.equal(await isOpen(page, 'ds-dp-source'), true);
      assert.equal(await page.inputValue('#ds-dp-source [data-dp-hidden]'), '');
      assert.match(await booked.getAttribute('aria-label'), /unavailable$/);
      assert.doesNotMatch(await booked.getAttribute('aria-label'), /booked/i);
      assert.equal(await booked.getAttribute('aria-disabled'), 'true');
      assert.equal(await booked.getAttribute('disabled'), null);
      // an unknown day (missing from the response: every 11th) — page ahead, since
      // this month's 11th/22nd are already past. No message, no event.
      await page.locator('#ds-dp-source [data-dp-next]').click();
      await page.waitForSelector('#ds-dp-source .dp__month[aria-busy="false"]', { timeout: 5000 });
      const unknown = page.locator('#ds-dp-source .dp__day--unknown').first();
      await unknown.click({ force: true });
      assert.equal(await page.textContent('#ds-dp-source [data-dp-message]'), '');
      assert.equal((await events(page)).filter((e) => e.n === 'change' || e.n === 'invalid').length, 0);
    });
  });

  it('mounts invalid from the error prop and clears when a date is chosen', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      const field = page.locator('#ds-dp-error .dp__field');
      assert.equal(await field.getAttribute('aria-invalid'), 'true');
      assert.match(await field.getAttribute('aria-describedby'), /ds-dp-error-help ds-dp-error-feedback/);
      assert.equal(await page.locator('#ds-dp-error .invalid-feedback').isVisible(), true);
      assert.equal(await field.evaluate((el) => getComputedStyle(el).backgroundImage), 'none'); // Bootstrap icon suppressed
      await page.locator('#ds-dp-error').scrollIntoViewIfNeeded();
      await openPicker(page, 'ds-dp-error');
      await page.locator('#ds-dp-error .dp__day--available').first().click();
      assert.equal(await field.getAttribute('aria-invalid'), null);
      assert.equal(await page.locator('#ds-dp-error .invalid-feedback').isVisible(), false);
    });
  });
});

describe('availability loading', () => {
  it('shows a skeleton while loading, then an inline error with a manual Retry (no toast)', async () => {
    const page = await pageOf(DEVICES.iphone375, PAGES.designSystem);
    await cleanly(page, async () => {
      await page.locator('#ds-dp-source').scrollIntoViewIfNeeded();
      await openPicker(page, 'ds-dp-source');
      const month = page.locator('#ds-dp-source [data-dp-month]');
      assert.equal(await month.getAttribute('aria-busy'), 'true');
      assert.equal(await page.locator('#ds-dp-source [data-dp-skeleton]').isVisible(), true);
      assert.equal(await page.getAttribute('#ds-dp-source [data-dp-skeleton]', 'aria-hidden'), 'true');
      assert.equal(await page.locator('#ds-dp-source .spinner-border, #ds-dp-source .palm-spinner').count(), 0);
      await page.waitForFunction(() => document.querySelector('#ds-dp-source [data-dp-status]').textContent.startsWith('Loading availability for'));
      await page.waitForSelector('#ds-dp-source .dp__month[aria-busy="false"]');
      // page forward twice: month +2 fails its first request
      const next = page.locator('#ds-dp-source [data-dp-next]');
      await next.click();
      await page.waitForSelector('#ds-dp-source .dp__month[aria-busy="false"]');
      await next.click();
      const error = page.locator('#ds-dp-source [data-dp-error]');
      await error.waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await error.getAttribute('role'), 'alert');
      assert.match(await error.textContent(), /Couldn't load availability/);
      assert.equal(await page.locator('.toast.show').count(), 0);
      assert.equal(await page.locator('#ds-dp-source .dp__day--available').count(), 0); // everything unknown
      await page.locator('#ds-dp-source [data-dp-retry]').click();
      await page.waitForSelector('#ds-dp-source .dp__month[aria-busy="false"]');
      await page.waitForFunction(() => document.querySelector('#ds-dp-source [data-dp-error]').hidden);
      assert.ok(await page.locator('#ds-dp-source .dp__day--available').count() > 0);
    });
  });

  it('a superseded source cannot land late (setSource clears the cache and stale responses)', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      await page.locator('#ds-dp-basic').scrollIntoViewIfNeeded(); // open() closes at once if the field is off-screen (§10)
      const result = await page.evaluate(async () => {
        const { getDatePicker } = await import('/src/scripts/date-picker.js');
        const picker = getDatePicker(document.getElementById('ds-dp-basic'));
        let releaseOld;
        picker.setSource(() => new Promise((res) => { releaseOld = () => res({}); }));
        picker.open();
        const before = picker.stateOf(picker.focusDate);
        picker.setSource(() => Promise.resolve({ [picker.focusDate]: 'available' }));
        releaseOld(); // old source answers after being replaced
        await new Promise((r) => setTimeout(r, 200));
        const after = picker.stateOf(picker.focusDate);
        picker.close();
        return { before, after };
      });
      assert.deepEqual(result, { before: 'unknown', after: 'available' });
    });
  });
});

describe('positioning on mobile', () => {
  for (const [name, device] of [['320×568', DEVICES.iphoneSE320], ['375×667', DEVICES.iphone375], ['Pixel 412×915', DEVICES.pixel]]) {
    it(`panel stays inside the viewport and cells stay ≥ 36px (${name})`, async () => {
      const page = await pageOf(device);
      await cleanly(page, async () => {
        await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
        await openPicker(page, 'mt-dp-page-a');
        const box = await panelBox(page, 'mt-dp-page-a');
        assert.ok(insideViewport(box), JSON.stringify(box));
        assert.ok(box.width <= box.vw - 32 + 0.5, 'width is min(22rem, 100vw - 2rem)');
        const cell = await page.locator('#mt-dp-page-a .dp__day').first().boundingBox();
        assert.ok(cell.width >= 36 && cell.height >= 36, JSON.stringify(cell));
        if (device.viewport.width >= 375) assert.ok(cell.width >= 44 - 1);
        const horizontal = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(horizontal, false);
      });
    });
  }

  it('field at the bottom of the page flips above without growing the document', async () => {
    const page = await pageOf(DEVICES.iphone375);
    await cleanly(page, async () => {
      await scrollFieldToBottom(page, '#mt-dp-page-b .dp__field');
      const before = await page.evaluate(() => document.documentElement.scrollHeight);
      await openPicker(page, 'mt-dp-page-b');
      const box = await panelBox(page, 'mt-dp-page-b');
      assert.equal(box.side, 'above');
      assert.ok(insideViewport(box), JSON.stringify(box));
      assert.equal(box.docHeight, before, 'opening must not extend the document');
    });
  });

  it('short landscape viewport: shrinks with internal scroll under a sticky header, compact cells', async () => {
    const page = await pageOf(DEVICES.iphoneSE320Landscape); // 568×320
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      const box = await panelBox(page, 'mt-dp-page-a');
      assert.ok(insideViewport(box), JSON.stringify(box));
      assert.ok(box.maxHeight, 'max-height applied');
      assert.equal(box.scrollable, true);
      const cell = await page.locator('#mt-dp-page-a .dp__day').first().boundingBox();
      assert.ok(cell.height >= 36 && cell.height < 44, `compact cell ${cell.height}`);
      // header stays pinned while the body scrolls
      const headerTop = () => page.evaluate(() => document.querySelector('#mt-dp-page-a .dp__header').getBoundingClientRect().top - document.querySelector('#mt-dp-page-a .dp__panel').getBoundingClientRect().top);
      const before = await headerTop();
      await page.evaluate(() => { document.querySelector('#mt-dp-page-a .dp__panel').scrollTop = 500; });
      assert.ok(Math.abs((await headerTop()) - before) < 1.5);
    });
  });

  it('rotating while open repositions without closing or losing month/focus/draft', async () => {
    const page = await pageOf(DEVICES.iphone375);
    await cleanly(page, async () => {
      // Rotating reflows the page text, which can scroll a normal field out of
      // view (and closing then is correct, §10). Pin it so this test isolates
      // reposition-without-state-loss.
      await page.evaluate(() => {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;top:90px;left:16px;width:280px;z-index:1';
        document.body.append(wrap);
        wrap.append(document.getElementById('mt-dp-page-a'));
      });
      await openPicker(page, 'mt-dp-page-a');
      await page.keyboard.press('PageDown');
      await page.keyboard.press('ArrowRight');
      const state = () => page.evaluate(async () => {
        const { getDatePicker } = await import('/src/scripts/date-picker.js');
        const p = getDatePicker(document.getElementById('mt-dp-page-a'));
        return { month: p.viewMonth, focus: p.focusDate, draft: p.draft, active: document.activeElement.dataset.date };
      });
      const before = await state();
      await page.setViewportSize({ width: 667, height: 375 });
      await page.waitForTimeout(300);
      assert.equal(await isOpen(page, 'mt-dp-page-a'), true);
      assert.deepEqual(await state(), before);
      assert.ok(insideViewport(await panelBox(page, 'mt-dp-page-a')));
      await page.setViewportSize({ width: 375, height: 667 });
      await page.waitForTimeout(300);
      assert.equal(await isOpen(page, 'mt-dp-page-a'), true);
      assert.deepEqual(await state(), before);
      assert.ok(insideViewport(await panelBox(page, 'mt-dp-page-a')));
    });
  });

  it('a shrinking viewport (keyboard) re-places the panel inside the new height, keeping state', async () => {
    const page = await pageOf(DEVICES.pixel);
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-b').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-b');
      const client = await page.context().newCDPSession(page);
      const sides = [];
      for (const height of [915, 600, 460, 915]) {
        await client.send('Emulation.setDeviceMetricsOverride', { width: 412, height, deviceScaleFactor: 2.6, mobile: true });
        await page.waitForTimeout(350);
        if (!(await isOpen(page, 'mt-dp-page-b'))) { sides.push('closed'); continue; }
        const box = await panelBox(page, 'mt-dp-page-b');
        assert.ok(insideViewport(box, 1), `height ${height}: ${JSON.stringify(box)}`);
        sides.push(box.side);
      }
      assert.ok(sides.every((s) => s === 'below' || s === 'above'), `stayed open: ${sides}`);
    });
  });

  it('site header (fixed) is treated as unavailable space', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      // put the field just under the fixed header, then open
      await page.evaluate(() => {
        const r = document.querySelector('#mt-dp-page-a .dp__field').getBoundingClientRect();
        window.scrollBy(0, r.top - 90);
      });
      await page.evaluate(() => { document.body.style.minHeight = '0'; });
      await openPicker(page, 'mt-dp-page-a');
      const box = await panelBox(page, 'mt-dp-page-a');
      const header = await page.evaluate(() => document.querySelector('header.position-fixed')?.getBoundingClientRect().bottom ?? 0);
      assert.ok(box.top >= header - 0.5, `panel top ${box.top} vs header bottom ${header}`);
    });
  });
});

describe('dismissal', () => {
  it('an outside tap closes without stealing focus; a drag/scroll gesture does not close', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      // drag across an outside target (> 10px) → not a tap
      const blank = await page.locator('#mt-dp-page p').first().boundingBox(); // non-focusable outside target
      await page.mouse.move(blank.x + 10, blank.y + 4);
      await page.mouse.down();
      await page.mouse.move(blank.x + 10, blank.y + 64, { steps: 4 });
      await page.mouse.up();
      assert.equal(await isOpen(page, 'mt-dp-page-a'), true, 'drag must not close');
      // wheel scrolling never closes
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(150);
      assert.equal(await isOpen(page, 'mt-dp-page-a'), true, 'scroll must not close');
      // a real tap on another focusable control closes and leaves focus on that control
      await page.evaluate(() => {
        const probe = document.createElement('button');
        probe.id = 'outside-probe';
        probe.textContent = 'outside';
        probe.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:5';
        document.body.append(probe);
      });
      await page.locator('#outside-probe').click();
      assert.equal(await isOpen(page, 'mt-dp-page-a'), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'outside-probe');
    });
  });

  it('touch-scroll gesture (pointercancel) does not close; Tab-out closes without restoring focus', async () => {
    const page = await pageOf(DEVICES.pixel);
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      const client = await page.context().newCDPSession(page);
      await client.send('Input.synthesizeScrollGesture', { x: 200, y: 700, yDistance: -120, speed: 600, gestureSourceType: 'touch' });
      await page.waitForTimeout(200);
      assert.equal(await isOpen(page, 'mt-dp-page-a'), true);
      // Tab past the last control in the panel
      for (let i = 0; i < 12 && (await isOpen(page, 'mt-dp-page-a')); i += 1) await page.keyboard.press('Tab');
      assert.equal(await isOpen(page, 'mt-dp-page-a'), false);
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'mt-dp-page-a-field');
    });
  });

  it('opening one picker closes the other; ids never collide', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      await page.locator('#mt-dp-page-b .dp__field').click();
      await page.waitForFunction(() => !document.querySelector('#mt-dp-page-b .dp__panel').hidden);
      assert.equal(await isOpen(page, 'mt-dp-page-a'), false);
      const dupes = await page.evaluate(() => {
        const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
        return ids.filter((id, i) => ids.indexOf(id) !== i);
      });
      assert.deepEqual(dupes, []);
    });
  });

  it('disabling while open closes it without restoring focus', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await page.locator('#mt-dp-page-a').scrollIntoViewIfNeeded();
      await openPicker(page, 'mt-dp-page-a');
      await page.evaluate(async () => {
        const { getDatePicker } = await import('/src/scripts/date-picker.js');
        getDatePicker(document.getElementById('mt-dp-page-a')).setDisabled(true);
      });
      assert.equal(await isOpen(page, 'mt-dp-page-a'), false);
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'mt-dp-page-a-field', 'focus is not restored');
      assert.equal(await page.locator('#mt-dp-page-a .dp__field').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.querySelector('#mt-dp-page-a').classList.contains('is-disabled')), true);
    });
  });
});

describe('year selection', () => {
  const setup = async (page, rules) => {
    await page.locator('#ds-dp-years').scrollIntoViewIfNeeded();
    await page.evaluate(async (r) => {
      const { getDatePicker } = await import('/src/scripts/date-picker.js');
      getDatePicker(document.getElementById('ds-dp-years')).setRules(r);
    }, rules);
  };
  const wide = { today: '2026-03-10', minDate: '2026-03-10', maxDate: '2030-12-31' };
  const month = (page) => page.textContent('#ds-dp-years [data-dp-title]');

  it('title opens a year grid of the window; choosing a year keeps the month and returns to the dates', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      await setup(page, wide);
      await openPicker(page, 'ds-dp-years');
      const toggle = page.locator('#ds-dp-years [data-dp-year-toggle]');
      assert.equal(await toggle.isEnabled(), true);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await month(page), 'March 2026');
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      const years = await page.locator('#ds-dp-years .dp__year').allTextContents();
      assert.deepEqual(years, ['2026', '2027', '2028', '2029', '2030']);
      assert.equal(await page.locator('#ds-dp-years .dp__year--selected').textContent(), '2026');
      assert.equal(await page.locator('#ds-dp-years [data-dp-month]').isVisible(), false);
      assert.equal(await page.locator('#ds-dp-years [data-dp-legend]').isVisible(), false);
      assert.equal(await page.getAttribute('#ds-dp-years [data-dp-prev]', 'aria-disabled'), 'true');
      assert.equal(await page.locator('#ds-dp-years .dp__year[tabindex="0"]').count(), 1);
      await page.locator('#ds-dp-years .dp__year', { hasText: '2028' }).click();
      assert.equal(await month(page), 'March 2028');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await isOpen(page, 'ds-dp-years'), true);
      assert.equal(await page.locator('#ds-dp-years [data-dp-month]').isVisible(), true);
      assert.match(await page.evaluate(() => document.activeElement.className), /dp__day/);
      // and it still selects a date normally
      await page.locator('#ds-dp-years .dp__day--available').first().click();
      assert.match(await page.inputValue('#ds-dp-years [data-dp-hidden]'), /^2028-03-\d\d$/);
    });
  });

  it('keyboard: Enter opens, arrows move, Enter chooses; Esc steps back before closing', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      await setup(page, wide);
      await openPicker(page, 'ds-dp-years');
      await page.locator('#ds-dp-years [data-dp-year-toggle]').focus();
      await page.keyboard.press('Enter');
      const focusedYear = () => page.evaluate(() => document.activeElement.dataset.year);
      assert.equal(await focusedYear(), '2026');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      assert.equal(await focusedYear(), '2028');
      await page.keyboard.press('End');
      assert.equal(await focusedYear(), '2030');
      await page.keyboard.press('Enter');
      assert.equal(await month(page), 'March 2030');
      // Esc from the year view returns to the dates, picker stays open
      await page.locator('#ds-dp-years [data-dp-year-toggle]').focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page, 'ds-dp-years'), true);
      assert.equal(await page.locator('#ds-dp-years [data-dp-month]').isVisible(), true);
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute('data-dp-year-toggle')), true);
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page, 'ds-dp-years'), false);
    });
  });

  it('choosing a year clamps the month into the window and the day into the month', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      await setup(page, { today: '2026-09-10', minDate: '2026-09-10', maxDate: '2029-03-20' });
      await openPicker(page, 'ds-dp-years');
      // jump to Jan 2029 via Shift+PageDown ×2 (clamped), then choose 2026: January < window start
      await page.keyboard.press('Shift+PageDown');
      await page.keyboard.press('Shift+PageDown');
      assert.equal(await month(page), 'September 2028');
      await page.keyboard.press('Shift+PageDown');
      assert.equal(await month(page), 'March 2029'); // clamped at the window's last day
      await page.locator('#ds-dp-years [data-dp-year-toggle]').click();
      await page.locator('#ds-dp-years .dp__year', { hasText: '2026' }).click();
      assert.equal(await month(page), 'September 2026'); // March is before the first month → first month
    });
  });

  it('a window inside one year leaves the title as a plain heading; yearSelection is respected', async () => {
    const page = await pageOf(DEVICES.desktop, PAGES.designSystem);
    await cleanly(page, async () => {
      await setup(page, { today: '2026-03-10', minDate: '2026-03-10', maxDate: '2026-11-30' });
      await openPicker(page, 'ds-dp-years');
      const toggle = page.locator('#ds-dp-years [data-dp-year-toggle]');
      assert.equal(await toggle.isDisabled(), true);
      assert.equal(await toggle.getAttribute('role'), 'presentation');
      assert.equal(await page.locator('#ds-dp-years .dp__title-icon').isVisible(), false);
      assert.equal(await page.locator('#ds-dp-years [data-dp-title-hint]').isVisible(), false);
      // the grid is still labelled by the month title
      assert.equal(await page.getAttribute('#ds-dp-years [data-dp-grid]', 'aria-labelledby'), 'ds-dp-years-month');
    });
  });

  it('mobile 320: the year grid fits the panel and the viewport', async () => {
    const page = await pageOf(DEVICES.iphoneSE320, PAGES.designSystem);
    await cleanly(page, async () => {
      await setup(page, wide);
      await openPicker(page, 'ds-dp-years');
      await page.locator('#ds-dp-years [data-dp-year-toggle]').click();
      await page.waitForTimeout(150);
      const box = await panelBox(page, 'ds-dp-years');
      assert.ok(insideViewport(box, 1), JSON.stringify(box));
      const cell = await page.locator('#ds-dp-years .dp__year').first().boundingBox();
      assert.ok(cell.width >= 44 && cell.height >= 36, JSON.stringify(cell));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
    });
  });
});

describe('inside a Bootstrap modal / offcanvas', () => {
  const openModal = async (page, id) => {
    await page.click(`[data-bs-target="#${id}"]`);
    await page.waitForFunction((mid) => document.getElementById(mid).classList.contains('show') && !document.querySelector('.modal.showing'), id);
    await page.waitForTimeout(400); // fade transition
  };

  it('plain modal: panel is not clipped, sits above content, Esc closes only the picker, then the modal', async () => {
    const page = await pageOf(DEVICES.iphone375);
    await cleanly(page, async () => {
      await openModal(page, 'mt-dp-plain');
      await openPicker(page, 'mt-dp-1');
      const box = await panelBox(page, 'mt-dp-1');
      assert.ok(insideViewport(box), JSON.stringify(box));
      const covered = await page.evaluate(() => {
        const r = document.querySelector('#mt-dp-1 .dp__panel').getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        return !hit?.closest('#mt-dp-1 .dp__panel');
      });
      assert.equal(covered, false, 'something paints above the panel');
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page, 'mt-dp-1'), false);
      assert.equal(await page.evaluate(() => document.getElementById('mt-dp-plain').classList.contains('show')), true, 'modal must survive the first Esc');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'mt-dp-1-field');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('mt-dp-plain').classList.contains('show'));
    });
  });

  it('focusing a text input while open closes the picker and keeps focus on the input', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await openModal(page, 'mt-dp-plain');
      await openPicker(page, 'mt-dp-1');
      await page.click('#mt-dp-text');
      assert.equal(await isOpen(page, 'mt-dp-1'), false);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'mt-dp-text');
    });
  });

  it('backdrop tap closes only the picker; the modal needs a second tap', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await openModal(page, 'mt-dp-plain');
      await openPicker(page, 'mt-dp-1');
      await page.mouse.click(20, 400); // the .modal element outside the dialog = backdrop
      await page.waitForTimeout(300);
      assert.equal(await isOpen(page, 'mt-dp-1'), false);
      assert.equal(await page.evaluate(() => document.getElementById('mt-dp-plain').classList.contains('show')), true, 'same tap must not dismiss the modal');
      await page.mouse.click(20, 400);
      await page.waitForFunction(() => !document.getElementById('mt-dp-plain').classList.contains('show'));
    });
  });

  it('scrollable modal: panel follows the field while .modal-body scrolls and is never clipped', async () => {
    const page = await pageOf(DEVICES.iphone375);
    await cleanly(page, async () => {
      await openModal(page, 'mt-dp-scrollable');
      await page.evaluate(() => {
        const body = document.querySelector('#mt-dp-scrollable .modal-body');
        const field = document.querySelector('#mt-dp-2 .dp__field');
        body.scrollTop += field.getBoundingClientRect().top - body.getBoundingClientRect().top - 120;
      });
      await openPicker(page, 'mt-dp-2');
      const gap = () => page.evaluate(() => document.querySelector('#mt-dp-2 .dp__panel').getBoundingClientRect().top - document.querySelector('#mt-dp-2 .dp__field').getBoundingClientRect().bottom);
      const before = await gap();
      assert.ok(insideViewport(await panelBox(page, 'mt-dp-2')));
      await page.evaluate(() => { document.querySelector('#mt-dp-scrollable .modal-body').scrollTop += 40; });
      await page.waitForTimeout(150);
      if (await isOpen(page, 'mt-dp-2')) {
        assert.ok(Math.abs((await gap()) - before) < 1.5, 'panel keeps its anchor to the field');
        assert.ok(insideViewport(await panelBox(page, 'mt-dp-2')));
      }
    });
  });

  it('hiding the modal closes the picker without restoring focus', async () => {
    const page = await pageOf(DEVICES.desktop);
    await cleanly(page, async () => {
      await openModal(page, 'mt-dp-plain');
      await openPicker(page, 'mt-dp-1');
      // Bootstrap dispatches this on the modal element when hide() starts.
      await page.evaluate(() => document.getElementById('mt-dp-plain').dispatchEvent(new Event('hide.bs.modal', { bubbles: true })));
      assert.equal(await isOpen(page, 'mt-dp-1'), false);
      assert.notEqual(await page.evaluate(() => document.activeElement.id), 'mt-dp-1-field');
    });
  });

  it('offcanvas: panel inside viewport; hiding the offcanvas closes the picker', async () => {
    const page = await pageOf(DEVICES.iphone375);
    await cleanly(page, async () => {
      await page.click('[data-bs-target="#mt-dp-offcanvas"]');
      await page.waitForFunction(() => document.getElementById('mt-dp-offcanvas').classList.contains('show') && !document.getElementById('mt-dp-offcanvas').classList.contains('showing'));
      await page.waitForTimeout(400);
      await openPicker(page, 'mt-dp-3');
      assert.ok(insideViewport(await panelBox(page, 'mt-dp-3')));
      await page.keyboard.press('Escape');
      assert.equal(await isOpen(page, 'mt-dp-3'), false);
      assert.equal(await page.evaluate(() => document.getElementById('mt-dp-offcanvas').classList.contains('show')), true);
    });
  });
});
