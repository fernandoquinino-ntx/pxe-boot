'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { installMock, sampleImages } = require('./helpers/pxe-mock');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* optional dependency */ }

const PAGE = 'file://' + path.join(__dirname, '..', 'src', 'renderer', 'index.html').split(path.sep).join('/');

test('renderer UI (mock preload bridge)', { timeout: 40000 }, async (t) => {
  if (!chromium) return t.skip('playwright is not installed; skipping UI test');
  let browser;
  try { browser = await chromium.launch(); } catch (e) { return t.skip('no Chromium for playwright: ' + e.message.split('\n')[0]); }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));
    await installMock(page, { images: sampleImages() });
    await page.goto(PAGE);
    await page.waitForSelector('#quick-list li.img');

    assert.equal(await page.locator('#quick-list li.img').count(), 9);
    assert.equal(await page.locator('#image-list li.img').count(), 6);
    // layout: title column must not be squeezed, and the page must not scroll sideways
    const w = await page.locator('#quick-list li.img >> nth=0').locator('.title').evaluate((el) => el.getBoundingClientRect().width);
    assert.ok(w > 150, 'quick download title is squeezed: ' + w);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');

    const jetson = page.locator('#quick-list li.img', { hasText: 'Jetson' });
    assert.equal(await jetson.locator('button[data-dl]').count(), 0);
    assert.equal(await jetson.locator('a[data-page]').count(), 1);

    const fedora = page.locator('#quick-list li.img', { hasText: 'Fedora' });
    await fedora.locator('button[data-dl]').click();
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'addUrl'));
    const add = await page.evaluate(() => window.__calls.find((c) => c[0] === 'addUrl'));
    assert.match(add[1], /Fedora-Workstation-Live.*\.iso$/);
    await page.waitForFunction(() => document.querySelector('#quick-list li.img:nth-child(3) button')?.textContent === 'Added');
    assert.equal(await fedora.locator('button[data-dl]').isDisabled(), true);

    await jetson.locator('a[data-page]').click();
    assert.ok(await page.evaluate(() => window.__calls.some((c) => c[0] === 'openUrl' && /nvidia/.test(c[1]))));

    await page.click('#quick-refresh');
    await page.waitForFunction(() => window.__calls.filter((c) => c[0] === 'catalog').length === 2);
    assert.equal(await page.locator('#quick-list li.img').count(), 9);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
