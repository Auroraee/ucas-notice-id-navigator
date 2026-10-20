'use strict';
// Real layout regression, using a fresh headless browser and an offline document only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.join(__dirname, '..');
const scriptFlag = process.argv.indexOf('--script');
const source = fs.readFileSync(scriptFlag < 0
  ? path.join(root, 'new-ucas-notice-id-navigator.user.js')
  : path.resolve(process.argv[scriptFlag + 1]), 'utf8');
assert.equal(source.split('  bootstrap();').length, 2);
const instrumented = source.replace('  bootstrap();', '  globalThis.__layout = { state, makeEntry, renderResults };\n  bootstrap();');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'mc-body-notice.html'), 'utf8');
const target = 'http://127.0.0.1/notice/1/10/view';

async function launchBrowser() {
  const channels = process.env.UCAS_TEST_BROWSER ? [process.env.UCAS_TEST_BROWSER] : ['msedge', 'chrome'];
  const failures = [];
  for (const channel of channels) {
    try { return await chromium.launch({ channel, headless: true }); }
    catch (e) { failures.push(`${channel}: ${e.message}`); }
  }
  throw new Error(`Install Microsoft Edge or Google Chrome to run the layout tests.\n${failures.join('\n')}`);
}

async function checkLayout(browser, width, height) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers: 'block' });
  const unexpectedRequests = [];
  // No live server or school session is involved. Never let the test escape its fixture.
  await context.route('**/*', async route => {
    if (route.request().url() === target) {
      await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
    } else {
      unexpectedRequests.push(route.request().url());
      await route.abort();
    }
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(target);
    await page.addScriptTag({ content: instrumented });
    await page.evaluate(() => {
      const { state, makeEntry, renderResults } = globalThis.__layout;
      const shadow = document.getElementById('ucas-notice-nav-host').shadowRoot;
      state.results.clear();
      for (let id = 100; id < 150; id++) {
        state.results.set(id, makeEntry(id, 'ok', {
          title: `2025-2026 学年课程说明 ${id}`,
          bodyText: '用于验证长结果列表的离线正文。', bodyComplete: true
        }));
      }
      shadow.querySelector('#expression').value = '';
      shadow.querySelector('#onlyHit').checked = false;
      shadow.querySelector('#freqFold').open = true;
      renderResults();
    });
    const dimensions = await page.evaluate(() => {
      const s = document.getElementById('ucas-notice-nav-host').shadowRoot;
      const panel = s.querySelector('#panel').getBoundingClientRect();
      const body = s.querySelector('.body');
      const results = s.querySelector('#results');
      return {
        panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right },
        bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight,
        resultHeight: results.clientHeight, resultScrollHeight: results.scrollHeight,
        zoom: window.visualViewport.scale
      };
    });
    assert.equal(dimensions.zoom, 1, 'test must run at 100% page scale');
    assert.ok(dimensions.panel.top >= 0 && dimensions.panel.bottom <= height, 'panel stays inside viewport vertically');
    assert.ok(dimensions.panel.left >= 0 && dimensions.panel.right <= width, 'panel stays inside viewport horizontally');
    assert.ok(dimensions.resultHeight >= 100, `results must not shrink away: ${dimensions.resultHeight}px`);
    assert.ok(dimensions.resultScrollHeight > dimensions.resultHeight, 'long result list can scroll');
    assert.ok(dimensions.bodyScrollHeight > dimensions.bodyHeight, 'expanded controls have an outer scroll area');

    const bodyBox = await page.locator('.body').boundingBox();
    await page.mouse.move(bodyBox.x + 4, bodyBox.y + 40);
    await page.mouse.wheel(0, 350);
    await page.waitForFunction(() => document.getElementById('ucas-notice-nav-host').shadowRoot.querySelector('.body').scrollTop > 0);
    await page.locator('#showResults').click();
    const visible = await page.evaluate(() => {
      const s = document.getElementById('ucas-notice-nav-host').shadowRoot;
      const list = s.querySelector('#results'), body = s.querySelector('.body');
      const r = list.getBoundingClientRect(), b = body.getBoundingClientRect();
      return { overlap: Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top), focused: s.activeElement === list, pageScroll: window.scrollY };
    });
    assert.ok(visible.overlap >= Math.min(100, dimensions.bodyHeight - 20), 'results shortcut reveals the list');
    assert.equal(visible.focused, true, 'results shortcut supports keyboard scrolling');
    assert.equal(visible.pageScroll, 0, 'shortcut does not move the underlying school page');
    await page.keyboard.press('PageDown');
    await page.waitForFunction(() => document.getElementById('ucas-notice-nav-host').shadowRoot.querySelector('#results').scrollTop > 0);
    await page.locator('#results').evaluate(el => { el.scrollTop = 0; });
    const resultsBox = await page.locator('#results').boundingBox();
    await page.mouse.move(resultsBox.x + 40, Math.max(resultsBox.y + 20, bodyBox.y + 20));
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(() => document.getElementById('ucas-notice-nav-host').shadowRoot.querySelector('#results').scrollTop > 0);

    if (width === 1366 && height === 650) {
      const output = path.join(root, '.local-debug');
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'layout-100-1366x650.png') });
    }
    assert.deepEqual(unexpectedRequests, [], 'all data comes from the offline fixture');
    assert.deepEqual(errors, [], 'no browser runtime exceptions');
    console.log(`PASS ${width}x${height}: body ${dimensions.bodyHeight}/${dimensions.bodyScrollHeight}px, results ${dimensions.resultHeight}/${dimensions.resultScrollHeight}px`);
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await launchBrowser();
  try {
    for (const [width, height] of [[1440, 900], [1440, 768], [1366, 650], [1024, 540], [390, 640], [1280, 420], [1280, 300]]) {
      await checkLayout(browser, width, height);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
