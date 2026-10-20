// 消息通道韧性回归测试：复现并锁定
// “A listener indicated an asynchronous response by returning true,
//  but the message channel closed before a response was received”
// 运行方式与 selection.browser.cjs 相同（需要 NODE_PATH 指向 playwright 安装）：
//   NODE_PATH=/path/to/node_modules node tests/channel-resilience.browser.cjs
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = path.resolve(__dirname, '..');

const CHANNEL_ERROR =
  'A listener indicated an asynchronous response by returning true, ' +
  'but the message channel closed before a response was received';

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent('<h1>Channel resilience</h1><p id="text">Hello world.</p>');
    await page.evaluate(() => {
      window.messageListeners = [];
      window.settings = { targetLang: '中文' };
      window.settingsListeners = [];
      window.chrome = {
        storage: {
          local: { get: async () => ({ ...settings }) },
          onChanged: {
            addListener: fn => settingsListeners.push(fn),
            removeListener: fn => { settingsListeners = settingsListeners.filter(f => f !== fn); },
          },
        },
        runtime: {
          onMessage: {
            addListener: fn => messageListeners.push(fn),
            removeListener: fn => { messageListeners = messageListeners.filter(f => f !== fn); },
          },
          sendMessage: msg => {
            if (window.throwTranslate && msg.type === 'translate') throw new Error('Extension context invalidated.');
            if (msg.type !== 'translate') return Promise.resolve({ ok: true });
            if (window.rejectTranslate) return Promise.reject(new Error(window.channelError || 'port died'));
            return Promise.resolve({ text: '你好，世界。' });
          },
        },
      };
    });
    await page.addScriptTag({ path: path.join(dir, 'content.js') });
    const send = msg => page.evaluate(
      (m) => new Promise(resolve => {
        const replied = [];
        const onReply = r => { replied.push(r); resolve({ r, replied }); };
        messageListeners.forEach(fn => fn(m, {}, onReply));
      }),
      msg,
    );

    // 1) 后台 sendMessage 被 reject（如 service worker 被回收）时，
    //    translatePage 监听器仍必须回话，且把真实错误带给调用方。
    await page.evaluate(errText => { window.rejectTranslate = true; window.channelError = errText; }, CHANNEL_ERROR);
    {
      const { r } = await send({ type: 'translatePage', targetLang: '中文' });
      assert.ok(r && typeof r === 'object', 'listener must respond with an object');
      assert.ok(r.error && r.error.includes(CHANNEL_ERROR.slice(0, 40)),
        `expected propagated channel error, got: ${JSON.stringify(r)}`);
    }

    // 2) sendMessage 同步抛异常（扩展上下文失效）时，同样必须回话。
    await page.evaluate(() => { window.rejectTranslate = false; window.throwTranslate = true; });
    {
      const { r } = await send({ type: 'translatePage', targetLang: '中文' });
      assert.ok(r && typeof r === 'object', 'listener must respond with an object');
      assert.ok(/Extension context invalidated/.test(r.error),
        `expected context-invalidated error, got: ${JSON.stringify(r)}`);
    }

    // 3) 恢复正常后整页翻译照常工作并成功回话。
    await page.evaluate(() => { window.throwTranslate = false; });
    {
      const { r } = await send({ type: 'translatePage', targetLang: '中文' });
      assert.ok(r && (r.ok || r.translated !== undefined), `expected success, got: ${JSON.stringify(r)}`);
      assert.match(await page.textContent('#text'), /你好，世界。/);
    }

    // 4) 旧脚本 removeListener 抛异常（上下文失效）时，重新注入的新脚本不能被炸死。
    await page.evaluate(() => {
      window.chrome.runtime.onMessage.removeListener = () => { throw new Error('Extension context invalidated.'); };
    });
    await page.addScriptTag({ path: path.join(dir, 'content.js') });
    const listeners = await page.evaluate(() => messageListeners.length);
    assert.ok(listeners >= 2, `new content.js must survive old script throwing (got ${listeners} listeners)`);
    // 摘掉旧监听器，只保留新脚本，验证它工作正常
    await page.evaluate(() => { messageListeners.shift(); });
    {
      const { r } = await send({ type: 'ping' });
      assert.equal(r.version, '1.8.1', 'new script must be the responder after takeover');
      const { r: r2 } = await send({ type: 'translatePage', targetLang: '中文' });
      assert.ok(r2 && (r2.ok || r2.translated !== undefined), `expected success, got: ${JSON.stringify(r2)}`);
    }

    console.log('PASS: channel closed / context invalidated / takeover crash all handled with a real response.');
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
