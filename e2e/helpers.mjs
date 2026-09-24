// Shared plumbing for the browser tests (`npm run test:e2e`). The repo has no
// other browser test setup, so this starts its own `astro dev` server on a spare
// port and drives Chromium through playwright-core. Dev (not preview) on
// purpose: tests import `/src/scripts/<file>.js` to reach a controller, and the
// production build mangles export names.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

export const PORT = Number(process.env.E2E_PORT ?? 4599);
export const BASE = `http://localhost:${PORT}/heenat-prototype`;
export const PAGES = {
  designSystem: `${BASE}/design-system/`,
  componentTesting: `${BASE}/design-system/component-testing/`,
};

// Emulated devices. Real keyboard/visualViewport behaviour still needs a real
// iOS Safari and Android Chrome pass (docs/date-picker-test-plan.md).
export const DEVICES = {
  iphoneSE320: { viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  iphone375: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  pixel: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
  iphone375Landscape: { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  iphoneSE320Landscape: { viewport: { width: 568, height: 320 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1200, height: 800 } },
};

const findChromium = () => {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  for (const cache of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell')).sort().reverse()) {
      for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell-mac-x64', 'chrome-headless-shell-linux64']) {
        const exe = join(cache, dir, arch, 'chrome-headless-shell');
        if (existsSync(exe)) return exe;
      }
    }
  }
  return undefined; // let playwright-core use its own default
};

export const startServer = async () => {
  const proc = spawn('npx', ['astro', 'dev', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(PAGES.designSystem)).ok) return () => proc.kill();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('astro dev did not start');
};

export const launch = () => chromium.launch({ executablePath: findChromium() });

// A fresh page on `url` for `device`, with the astro dev toolbar removed (it
// covers the bottom of the viewport) and page errors collected on page.errors.
export const openPage = async (browser, device, url) => {
  const context = await browser.newContext(device);
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.addInitScript(() => {
    new MutationObserver(() => document.querySelectorAll('astro-dev-toolbar').forEach((el) => el.remove()))
      .observe(document, { childList: true, subtree: true });
  });
  await page.goto(url);
  await page.waitForSelector('[data-dp]');
  return page;
};

// Runs in the page: is the panel entirely inside the visible viewport, and by how much does it miss?
export const panelBox = (page, id) => page.evaluate((rootId) => {
  const panel = document.querySelector(`#${rootId} .dp__panel`);
  const r = panel.getBoundingClientRect();
  return {
    hidden: panel.hidden,
    left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
    vw: window.innerWidth, vh: window.innerHeight,
    side: panel.dataset.side,
    maxHeight: panel.style.maxHeight,
    scrollable: panel.scrollHeight > panel.clientHeight + 1,
    docHeight: document.documentElement.scrollHeight,
  };
}, id);

export const insideViewport = (b, tolerance = 0.5) => (
  b.left >= -tolerance && b.top >= -tolerance && b.right <= b.vw + tolerance && b.bottom <= b.vh + tolerance
);

export const isOpen = (page, id) => page.evaluate((rootId) => !document.querySelector(`#${rootId} .dp__panel`).hidden, id);

// Scroll the page so the element's bottom edge sits `gap` px above the bottom of the viewport.
export const scrollFieldToBottom = (page, selector, gap = 12) => page.evaluate(({ sel, gap: g }) => {
  const el = document.querySelector(sel);
  const rect = el.getBoundingClientRect();
  window.scrollBy(0, rect.bottom - (window.innerHeight - g));
}, { sel: selector, gap });

export const openPicker = async (page, id) => {
  await page.locator(`#${id} .dp__field`).click();
  await page.waitForFunction((rootId) => !document.querySelector(`#${rootId} .dp__panel`).hidden, id);
};
