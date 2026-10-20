// content.js — 注入网页，执行整页翻译与还原

(() => {
  // 改动 content.js 后要同步改 popup.js 的同名常量，否则新脚本不会接管旧脚本
  const VERSION = "1.8.1";

  // 脚本会注入到所有 frame（含 iframe），只有顶层 frame 负责回话，避免多个 frame 抢答
  const IS_TOP_FRAME = window.top === window;

  // 已打开页面里可能跑着旧版本，先让它拆掉自己的监听，再注册新的
  try {
    window.__aiTranslator?.destroy?.();
  } catch {
    // 重载扩展后旧脚本上下文已失效，访问 chrome.* 会抛错，忽略并直接接管
  }

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE", "KBD", "SAMP",
    "TEXTAREA", "INPUT", "SELECT", "OPTION", "BUTTON",
    "SVG", "CANVAS", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO",
  ]);

  const SPLIT_TOKEN = "[[[SPLIT]]]";
  const SPLIT_JOIN = `\n\n${SPLIT_TOKEN}\n\n`;
  const SPLIT_RE = /\[\[\[SPLIT\]\]\]/;
  const BATCH_SIZE = 2000; // 单次 API 请求的累计字符上限
  const CONCURRENCY = 4; // 同时发出的请求数
  const CACHE_LIMIT = 5000; // 译文缓存条数上限
  const RETRANSLATE_DELAY = 400; // DOM 变化后等待多久再补译

  const MARKER = "aiTranslate"; // 双语模式下插入的译文元素标记
  const originals = new Map(); // 替换模式：节点 -> 原文，用于还原
  const written = new Map(); // 替换模式：节点 -> 我们写入的译文，用于识别外部改写
  const handled = new Map(); // 双语模式：节点 -> 翻译时的原文，用于跳过已处理节点
  const cache = new Map(); // `${目标语言}::原文` -> 译文，重复段落只翻译一次

  let activeLang = null; // 当前翻译状态下的目标语言，null 表示未在翻译
  let mode = "replace"; // replace = 只留译文；bilingual = 原文后追加译文
  let observer = null;
  let debounceTimer = null;
  let running = false; // 同一时间只跑一个翻译任务

  const onMessage = (msg, _sender, sendResponse) => {
    if (msg.type === "ping") {
      if (!IS_TOP_FRAME) return; // 子 frame 不抢答
      sendResponse({
        ok: true,
        version: VERSION,
        hostname: location.hostname,
        translated: activeLang !== null,
      });
      return;
    }
    if (msg.type === "translatePage") {
      const task = translatePage(msg.targetLang);
      if (!IS_TOP_FRAME) return; // 子 frame 照常翻译，但不回话
      // 既然 return true 承诺了异步回复，成功和失败都必须回话；
      // 只 then 不 catch 的话，任务一 reject 对面就会等到
      // “message channel closed before a response was received”
      task.then(
        (r) => sendResponse(r),
        (e) => sendResponse({ error: e?.message || String(e) }),
      );
      return true; // 异步响应
    }
    if (msg.type === "restorePage") {
      restorePage();
      if (IS_TOP_FRAME) sendResponse({ ok: true });
    }
  };

  const onStorageChanged = (changes, area) => {
    if (area !== "local" || !changes.autoRetranslate) return;
    if (changes.autoRetranslate.newValue === false) stopObserver();
    else if (activeLang) startObserver();
  };

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);

  // 供新版本注入时接管，避免两个监听器同时响应
  window.__aiTranslator = {
    version: VERSION,
    destroy() {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
      restorePage();
    },
  };

  // ---------- DOM 扫描 ----------

  // 诊断日志用的短文本
  function clip(text) {
    const t = text.trim().replace(/\s+/g, " ");
    return t.length > 30 ? `${t.slice(0, 30)}…` : t;
  }

  // 该节点是因为哪个标签被跳过的，没有则返回 null
  function blockingTag(node) {
    let el = node.parentElement;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return el.tagName;
      if (el.dataset?.[MARKER] !== undefined) return "译文";
      el = el.parentElement;
    }
    return null;
  }

  function isSkippable(node) {
    return blockingTag(node) !== null;
  }

  function isVisible(node) {
    const el = node.parentElement;
    if (!el) return false;
    const style = getComputedStyle(el);
    return !(
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    );
  }

  // 收集所有要扫描的根：文档本体 + 所有 open shadow root
  function collectRoots(root) {
    const roots = [root];
    for (let i = 0; i < roots.length; i++) {
      for (const el of roots[i].querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  // 收集页面上需要翻译的文本节点
  function collectTextNodes(root) {
    const nodes = [];
    for (const scope of collectRoots(root)) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (isSkippable(node)) return NodeFilter.FILTER_REJECT;
          if (!isVisible(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
    }
    return nodes;
  }

  // 页面文本节点统计，用于诊断「为什么这段没翻译到」
  function pageStats(root) {
    const roots = collectRoots(root);
    let total = 0;
    let invisible = 0;
    let blocked = 0;
    const reasons = new Map();
    const blockedSamples = [];
    const invisibleSamples = [];

    for (const scope of roots) {
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (!node.nodeValue.trim()) continue;
        total++;

        const tag = blockingTag(node);
        if (tag) {
          blocked++;
          reasons.set(tag, (reasons.get(tag) ?? 0) + 1);
          if (blockedSamples.length < 5) blockedSamples.push(`[${tag}] ${clip(node.nodeValue)}`);
        } else if (!isVisible(node)) {
          invisible++;
          if (invisibleSamples.length < 5) invisibleSamples.push(clip(node.nodeValue));
        }
      }
    }

    const top = [...reasons]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag, n]) => `${tag}×${n}`);

    // iframe 里的文字扫不到，单独统计——很可能是「翻译不到」的原因
    let iframes = 0;
    let iframeTexts = 0;
    for (const frame of document.querySelectorAll("iframe")) {
      iframes++;
      try {
        const doc = frame.contentDocument;
        if (!doc?.body) continue;
        const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) if (node.nodeValue.trim()) iframeTexts++;
      } catch {
        // 跨域 iframe，读不到内容
      }
    }

    return {
      total,
      invisible,
      blocked,
      blockedTop: top.join(" "),
      blockedSamples,
      invisibleSamples,
      shadowRoots: roots.length - 1,
      iframes,
      iframeTexts,
    };
  }

  // 只取尚未翻译的节点（新插入的、或被框架刷回原文的）
  function isPending(node) {
    return mode === "bilingual"
      ? handled.get(node) !== node.nodeValue // 原文没变过就是已处理
      : written.get(node) !== node.nodeValue; // 被刷回原文才需要重译
  }

  function collectPending(root) {
    return collectTextNodes(root).filter(isPending);
  }

  // ---------- 分批 ----------

  // 入参是 [原文, 该原文对应的所有节点][]，同一段文字只翻译一次
  function makeBatches(entries) {
    const batches = [];
    let cur = [];
    let len = 0;
    for (const entry of entries) {
      if (len + entry[0].length > BATCH_SIZE && cur.length) {
        batches.push(cur);
        cur = [];
        len = 0;
      }
      cur.push(entry);
      len += entry[0].length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  // ---------- 翻译 ----------

  function requestTranslate(text, targetLang) {
    // 后台 service worker 被回收、扩展刚重载（上下文失效）时，
    // sendMessage 会直接 reject。这里把异常转成错误值向上传，
    // 避免 reject 一路炸穿 translatePage 导致消息通道无响应。
    return chrome.runtime.sendMessage({ type: "translate", text, targetLang })
      .catch((e) => ({ error: e?.message || String(e) }));
  }

  // 通知 background 把扩展图标切成转圈状态
  function setBusy(on) {
    chrome.runtime.sendMessage({ type: "busy", on }).catch(() => {});
  }

  // 双语模式下取（或创建）紧跟原文之后的译文元素
  function targetSpan(node) {
    const next = node.nextSibling;
    if (next?.nodeType === Node.ELEMENT_NODE && next.dataset[MARKER] !== undefined) {
      return next;
    }
    const span = document.createElement("span");
    span.dataset[MARKER] = "";
    node.after(span);
    return span;
  }

  // 写入译文：替换模式改原节点，双语模式在原文后追加
  function apply(node, text) {
    const value = text.trim();
    const source = node.nodeValue;

    if (mode === "bilingual") {
      if (value && value !== source.trim()) targetSpan(node).textContent = value;
      handled.set(node, source);
      return;
    }

    if (value && value !== source) {
      if (!originals.has(node)) originals.set(node, source);
      node.nodeValue = value;
    }
    written.set(node, value); // 即使没变也标记已处理，避免下次又被当成待翻译
  }

  function markHandled(node) {
    if (mode === "bilingual") handled.set(node, node.nodeValue);
    else written.set(node, node.nodeValue);
  }

  // 按原文去重：重复出现的段落（导航、列表项）只翻译一次
  function collectGroups(root) {
    const groups = new Map();
    for (const node of collectPending(root)) {
      const text = node.nodeValue.trim();
      const nodes = groups.get(text);
      if (nodes) nodes.push(node);
      else groups.set(text, [node]);
    }
    return [...groups.entries()];
  }

  // 已是目标语言的文本直接跳过，省掉整段请求
  function alreadyInTarget(text, lang) {
    const targetScript = {
      中文: /[一-鿿]/,
      日文: /[぀-ヿ]/,
      韩文: /[가-힯]/,
      俄文: /[Ѐ-ӿ]/,
      阿拉伯文: /[؀-ۿ]/,
    }[lang];
    const cjk = /[぀-ヿ一-鿿가-힯]/;
    const latin = /[A-Za-z]/;

    if (targetScript) return targetScript.test(text) && !latin.test(text);
    if (lang === "英文") return latin.test(text) && !cjk.test(text);
    return false;
  }

  async function translateGroups(entries, lang) {
    if (cache.size > CACHE_LIMIT) cache.clear();

    let count = 0;
    let skipped = 0;
    let cached = 0;
    const samples = []; // 诊断用：前几条「原文 → 译文」
    const pending = [];

    // 命中缓存 / 本来就是目标语言的，直接处理，不发请求
    for (const [text, nodes] of entries) {
      const hit = cache.get(`${lang}::${text}`);
      if (hit !== undefined) {
        for (const node of nodes) apply(node, hit);
        count += nodes.length;
        cached += nodes.length;
      } else if (alreadyInTarget(text, lang)) {
        for (const node of nodes) markHandled(node);
        skipped += nodes.length;
      } else {
        pending.push([text, nodes]);
      }
    }
    if (!pending.length) return { ok: true, translated: count, skipped, cached, samples };

    const queue = makeBatches(pending);
    let firstError = null;

    // 并发跑，谁先回来谁先写页面
    const worker = async () => {
      while (queue.length && !firstError) {
        const batch = queue.shift();
        const resp = await requestTranslate(
          batch.map(([text]) => text).join(SPLIT_JOIN),
          lang,
        );
        if (resp?.error) {
          firstError ??= resp.error;
          return;
        }

        const parts = (resp.text ?? "").split(SPLIT_RE);
        if (parts.length === batch.length) {
          batch.forEach(([text, nodes], i) => {
            const value = parts[i].trim();
            if (samples.length < 5) samples.push(`${clip(text)} → ${clip(value)}`);
            cache.set(`${lang}::${text}`, value);
            for (const node of nodes) apply(node, value);
            count += nodes.length;
          });
          continue;
        }

        // 分隔符对不上，逐条兜底，避免整批静默丢失
        console.warn(
          `[AI 翻译] 分隔符数量不匹配（期望 ${batch.length}，实得 ${parts.length}），改为逐条翻译`,
        );
        for (const [text, nodes] of batch) {
          const single = await requestTranslate(text, lang);
          if (single?.error) {
            firstError ??= single.error;
            return;
          }
          const value = (single.text ?? "").trim();
          cache.set(`${lang}::${text}`, value);
          for (const node of nodes) apply(node, value);
          count += nodes.length;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()),
    );

    return firstError
      ? { error: firstError, done: count, skipped, cached, samples }
      : { ok: true, translated: count, skipped, cached, samples };
  }

  async function translatePage(targetLang) {
    if (running) return { error: "正在翻译中，请稍候" };

    // 已翻译时再次触发 = 还原原文（语言没变）
    if (activeLang !== null) {
      if (activeLang === targetLang) {
        restorePage();
        return { ok: true, restored: true, translated: 0 };
      }
      restorePage(); // 目标语言变了，先还原再按新语言重译
    }

    const { autoRetranslate = true, showOriginal = true } = await chrome.storage.local.get([
      "autoRetranslate",
      "showOriginal",
    ]);
    mode = showOriginal ? "bilingual" : "replace";

    running = true;
    activeLang = targetLang;
    setBusy(true);
    try {
      const entries = collectGroups(document.body);
      if (!entries.length) {
        if (autoRetranslate) startObserver();
        return { ok: true, translated: 0, ...pageStats(document.body) };
      }
      const resp = await translateGroups(entries, targetLang);
      if (resp.error) {
        stopObserver();
        activeLang = null;
        return resp;
      }
      if (autoRetranslate) startObserver(); // 翻译期间持续监听动态内容

      const stats = pageStats(document.body);
      console.log("[AI 翻译] 诊断", {
        frame: IS_TOP_FRAME ? "top" : location.href,
        目标语言: targetLang,
        模式: mode,
        ...resp,
        ...stats,
      });
      return { ...resp, ...stats };
    } catch (e) {
      // 兜底：任何未预料的异常也要转成错误值返回，
      // 保证 onMessage 里的 sendResponse 一定被调用
      stopObserver();
      activeLang = null;
      return { error: e?.message || String(e) };
    } finally {
      running = false;
      setBusy(false);
    }
  }

  // ---------- 动态内容补译 ----------

  function onMutations(records) {
    if (!activeLang) return;
    const suspicious = records.some((r) => {
      // 显示/隐藏类属性变了（如展开下拉菜单），可能有新内容露出来
      if (r.type === "attributes") return true;
      // 替换模式下我们写入的值不会触发；被外部刷回原文的才会
      if (r.type === "characterData") {
        return mode === "bilingual" || r.target.nodeValue !== written.get(r.target);
      }
      return r.addedNodes.length > 0;
    });
    if (suspicious) scheduleRetranslate();
  }

  function scheduleRetranslate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(retranslatePending, RETRANSLATE_DELAY);
  }

  async function retranslatePending() {
    if (!activeLang || running) return;

    running = true;
    try {
      const entries = collectGroups(document.body);
      if (!entries.length) return;
      const resp = await translateGroups(entries, activeLang);
      if (resp.error) {
        // 出错（如额度不足）就停止监听，避免反复请求
        console.warn("[AI 翻译] 补译失败，已停止监听：", resp.error);
        stopObserver();
        activeLang = null;
      }
    } finally {
      running = false;
    }
  }

  function startObserver() {
    stopObserver();
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    clearTimeout(debounceTimer);
  }

  // ---------- 还原 ----------

  function restorePage() {
    stopObserver();
    activeLang = null;
    for (const [node, orig] of originals) node.nodeValue = orig;
    originals.clear();
    written.clear();
    handled.clear();
    for (const scope of collectRoots(document.body)) {
      for (const el of scope.querySelectorAll(`[data-${MARKER}]`)) el.remove();
    }
  }

  // ---------- 启动时自动翻译（该站点已开启「总是翻译」） ----------

  async function maybeAutoTranslate() {
    const { autoSites = [], targetLang = "中文" } = await chrome.storage.local.get([
      "autoSites",
      "targetLang",
    ]);
    if (autoSites.includes(location.hostname)) await translatePage(targetLang);
  }

  maybeAutoTranslate();
})();
