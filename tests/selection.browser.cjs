// Run with NODE_PATH pointing to a Playwright installation. Uses isolated Chrome and mocked extension APIs.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent('<h1>Selection translation</h1><p id="text">The request timed out.</p><div id="edit" contenteditable="true">Editable text</div><input value="Input text"><div id="outside">Outside</div>');
    await page.evaluate(() => {
      window.requests = [];
      window.settings = { targetLang: '中文' };
      window.settingsListeners = [];
      window.messageListeners = [];
      window.response = { text: '请求超时。' };
      window.chrome = {
        storage: {
          local: { get: async () => ({ ...settings }) },
          onChanged: { addListener: fn => settingsListeners.push(fn), removeListener: fn => { settingsListeners = settingsListeners.filter(f => f !== fn); } },
        },
        runtime: {
          onMessage: { addListener: fn => messageListeners.push(fn), removeListener: fn => { messageListeners = messageListeners.filter(f => f !== fn); } },
          sendMessage: async msg => {
            if (msg.type !== 'translate') return { ok: true };
            requests.push(msg);
            if (window.delayed) return new Promise(resolve => { window.resolvePending = resolve; });
            return window.response;
          },
        },
      };
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function(options) {
        const root = attach.call(this, options);
        if (this.hasAttribute('data-ai-selection-ui')) window.testRoot = root;
        return root;
      };
      window.selectText = id => {
        const range = document.createRange();
        range.selectNodeContents(document.getElementById(id));
        getSelection().removeAllRanges(); getSelection().addRange(range);
        document.getElementById(id).dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      };
    });
    await page.addScriptTag({ path: path.join(dir, 'content.js') });
    await page.addScriptTag({ path: path.join(dir, 'selection.js') });
    const select = () => page.evaluate(() => selectText('text'));
    const click = selector => page.evaluate(s => testRoot.querySelector(s).click(), selector);
    const result = () => page.evaluate(() => testRoot.querySelector('.result')?.textContent);
    const count = () => page.evaluate(() => requests.length);
    const visible = () => page.locator('[data-ai-selection-ui]').count();
    await select();
    assert.equal(await visible(), 1);
    assert.equal(await count(), 0, 'selection must not make a paid request');
    assert.equal(await page.evaluate(() => document.querySelector('[data-ai-selection-ui]').shadowRoot), null);
    await click('.trigger');
    await page.waitForFunction(() => testRoot.querySelector('.result').textContent === '请求超时。');
    assert.equal(await count(), 1);
    assert.deepEqual(await page.evaluate(() => requests[0]), { type: 'translate', text: 'The request timed out.', targetLang: '中文' });
    await page.evaluate(() => {
      window.copied = '';
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.copied = t; } } });
    });
    await click('.copy');
    assert.equal(await page.evaluate(() => copied), '请求超时。');
    // The page translator sees only webpage text, never the selection card.
    await page.evaluate(() => new Promise(resolve => messageListeners[0]({ type: 'translatePage', targetLang: '中文' }, {}, resolve)));
    assert.equal(await page.evaluate(() => requests.slice(1).some(r => /划词翻译|复制译文|正在翻译/.test(r.text))), false);
    await page.keyboard.press('Escape');
    assert.equal(await visible(), 0);
    await page.evaluate(() => selectText('edit'));
    assert.equal(await visible(), 0, 'editable content must not show trigger');
    await select(); await click('.trigger');
    await page.locator('#outside').click();
    assert.equal(await visible(), 0);
    await page.evaluate(() => { window.response = { error: '额度不足' }; });
    await select(); await click('.trigger');
    await page.waitForFunction(() => testRoot.querySelector('.result').textContent === '额度不足');
    assert.equal(await page.evaluate(() => testRoot.querySelector('.retry').hidden), false);
    await page.evaluate(() => { window.response = { text: '重试成功' }; });
    await click('.retry');
    await page.waitForFunction(() => testRoot.querySelector('.result').textContent === '重试成功');
    await page.evaluate(() => { window.delayed = true; });
    await select(); await click('.trigger');
    await page.waitForFunction(() => typeof resolvePending === 'function');
    await click('.close');
    await page.evaluate(() => { resolvePending({ text: '迟到结果' }); window.delayed = false; });
    assert.equal(await visible(), 0, 'late response must not reopen card');
    await select();
    await page.evaluate(() => settingsListeners.forEach(fn => fn({ selectionTranslate: { newValue: false } }, 'local')));
    assert.equal(await visible(), 0);
    await select(); assert.equal(await visible(), 0, 'disabled feature must not activate');
    await page.evaluate(() => settingsListeners.forEach(fn => fn({ selectionTranslate: { newValue: true } }, 'local')));
    await page.addScriptTag({ path: path.join(dir, 'selection.js') });
    assert.equal(await page.evaluate(() => settingsListeners.length), 2, 'reinjection must remove old listener');
    await page.setViewportSize({ width: 320, height: 400 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await select(); await click('.trigger');
    await page.waitForFunction(() => testRoot.querySelector('.result').textContent === '重试成功');
    const box = await page.evaluate(() => { const r = testRoot.querySelector('.card').getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; });
    assert.equal(await visible(), 1);
    assert.ok(box.right > box.left && box.bottom > box.top && box.left >= 0 && box.right <= 320 && box.top >= 0 && box.bottom <= 400, JSON.stringify(box));
    await page.screenshot({ path: path.join(dir, 'tests/selection-preview.png') });
    await page.evaluate(() => window.__aiSelectionTranslator.destroy());
    assert.equal(await visible(), 0);
    await select(); assert.equal(await visible(), 0);
    console.log('PASS: trigger without request, translation, copy, whole-page isolation, Escape/outside dismiss, editable exclusion, error/retry, stale response, settings toggle, reinjection cleanup, narrow viewport, destroy.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
