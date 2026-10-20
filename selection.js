// 划词翻译独立于整页翻译；关闭的 Shadow DOM 隔离站点样式与整页扫描。
(() => {
  window.__aiSelectionTranslator?.destroy();
  let enabled = true;
  let destroyed = false;
  let revision = 0;
  let host = null;
  let root = null;
  let source = '';
  let anchor = null;
  let timer = null;
  const listeners = [];
  const listen = (target, name, fn, options) => {
    target.addEventListener(name, fn, options);
    listeners.push(() => target.removeEventListener(name, fn, options));
  };
  function close() {
    revision++;
    clearTimeout(timer);
    host?.remove();
    host = root = null;
    source = '';
  }
  function inside(event) { return host && event.composedPath().includes(host); }
  function editable(node) {
    let el = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    while (el) {
      if (el.isContentEditable || el.matches('input,textarea,select,[role="textbox"],.monaco-editor,.cm-editor,.CodeMirror')) return true;
      el = el.parentElement || el.getRootNode()?.host;
    }
    return false;
  }
  function place() {
    if (!host || !anchor) return;
    const box = root.querySelector('.surface');
    const w = box.offsetWidth, h = box.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, innerWidth - w - 8));
    let top = anchor.bottom + 8;
    if (top + h > innerHeight - 8) top = Math.max(8, anchor.top - h - 8);
    host.style.setProperty('left', `${left}px`, 'important');
    host.style.setProperty('top', `${top}px`, 'important');
  }
  function mount() {
    host = document.createElement('div');
    host.setAttribute('data-ai-selection-ui', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host { color-scheme:light; }
      * { box-sizing:border-box; }
      .surface { font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#202124; background:#fff; border:1px solid #e6e6eb; border-radius:12px; box-shadow:0 6px 28px #0003; }
      button { font:inherit; cursor:pointer; border:0; border-radius:8px; padding:6px 12px; background:#f3f3f6; color:#34343c; }
      button:hover { background:#e9e9ee; } button:focus-visible { outline:2px solid #f0386e; outline-offset:2px; }
      button:disabled { cursor:default; opacity:.6; }
      .trigger { background:#f0386e; color:white; padding:7px 13px; }
      .trigger:hover { background:#d92e60; }
      .card { width:min(360px,calc(100vw - 16px)); max-height:calc(100vh - 16px); overflow:auto; padding:14px; }
      header,footer { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      header { font-weight:600; } .close { padding:0 8px; font-size:20px; background:transparent; }
      .source { color:#777; border-bottom:1px solid #eee; padding:10px 0; max-height:110px; overflow:auto; }
      .result { padding:12px 0; max-height:240px; overflow:auto; }
      .source,.result { white-space:pre-wrap; overflow-wrap:anywhere; user-select:text; }
      .error { color:#b42318; } footer { justify-content:flex-end; } [hidden] { display:none!important; }
    </style><button class="surface trigger" type="button" aria-label="翻译选中文字">译 翻译</button>`;
    document.documentElement.append(host);
    root.querySelector('button').addEventListener('click', showCard);
    place();
  }
  function capture(event) {
    if (!enabled || destroyed || inside(event) || (event.type === 'mouseup' && event.button !== 0)) return;
    if (event.type === 'keyup' && !event.key.startsWith('Arrow') && event.key !== 'Shift') return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount || editable(selection.anchorNode) || editable(selection.focusNode) || editable(event.composedPath()[0])) return;
    const text = selection.toString().trim();
    if (!text) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    close();
    source = text;
    anchor = { left: rect.left, top: rect.top, bottom: rect.bottom };
    mount();
  }
  function showCard() {
    const button = root.querySelector('.trigger');
    if (!button) return;
    const card = document.createElement('section');
    card.className = 'surface card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '划词翻译');
    card.innerHTML = `<header><span>划词翻译</span><button class="close" aria-label="关闭">×</button></header><div class="source"></div><div class="result" role="status" aria-live="polite"></div><footer><button class="retry" hidden>重试</button><button class="copy" hidden>复制译文</button></footer>`;
    button.replaceWith(card);
    card.querySelector('.source').textContent = source;
    card.querySelector('.close').addEventListener('click', close);
    card.querySelector('.retry').addEventListener('click', translate);
    card.querySelector('.copy').addEventListener('click', async () => {
      const copy = card.querySelector('.copy');
      try {
        await navigator.clipboard.writeText(card.querySelector('.result').textContent);
        copy.textContent = '已复制';
      } catch { copy.textContent = '请选中译文复制'; }
    });
    translate();
  }
  async function translate() {
    const id = ++revision;
    const card = root.querySelector('.card');
    const result = card.querySelector('.result');
    const retry = card.querySelector('.retry');
    const copy = card.querySelector('.copy');
    result.classList.remove('error');
    result.textContent = '正在翻译…';
    retry.hidden = copy.hidden = true;
    copy.textContent = '复制译文';
    place();
    try {
      if (source.length > 12000) throw new Error('选中文字过长，请分段选择（每次最多 12000 字符）。');
      const text = source;
      const response = await Promise.race([
        (async () => {
          const { targetLang = '中文' } = await chrome.storage.local.get('targetLang');
          if (id !== revision) return null;
          return chrome.runtime.sendMessage({ type: 'translate', text, targetLang });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('等待超时，请重试。')), 45000); }),
      ]);
      if (id !== revision) return;
      if (response?.error) throw new Error(response.error);
      if (!response?.text?.trim()) throw new Error('没有收到译文，请重试。');
      result.textContent = response.text.trim();
      copy.hidden = false;
    } catch (error) {
      if (id !== revision) return;
      result.textContent = error.message || '翻译失败，请重试。';
      result.classList.add('error');
      retry.hidden = false;
    } finally {
      if (id === revision) { clearTimeout(timer); place(); }
    }
  }
  listen(document, 'mouseup', capture);
  listen(document, 'keyup', capture);
  listen(document, 'pointerdown', event => { if (!inside(event)) close(); }, true);
  listen(document, 'keydown', event => { if (event.key === 'Escape') close(); }, true);
  listen(document, 'scroll', event => { if (!inside(event)) close(); }, true);
  listen(window, 'resize', close);
  const onSettings = (changes, area) => {
    if (area === 'local' && changes.selectionTranslate) {
      enabled = changes.selectionTranslate.newValue !== false;
      if (!enabled) close();
    }
  };
  chrome.storage.onChanged.addListener(onSettings);
  chrome.storage.local.get('selectionTranslate').then(settings => {
    if (!destroyed) { enabled = settings.selectionTranslate !== false; if (!enabled) close(); }
  }).catch(() => { enabled = false; close(); });
  window.__aiSelectionTranslator = {
    destroy() {
      destroyed = true;
      close();
      listeners.forEach(remove => remove());
      chrome.storage.onChanged.removeListener(onSettings);
    },
  };
})();
