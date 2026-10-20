// popup.js — 设置面板逻辑

const API_KEY_URL = "https://platform.deepseek.com/api_keys";
const HELP_URL = "https://api-docs.deepseek.com/zh-cn/";
const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";
const COMMAND_NAME = "translate-page";
const IS_MAC = navigator.userAgent.includes("Mac");

// Chrome 的 commands API 只有 getAll/onCommand，没有 update（那是 Firefox 的）。
// 支持时用面板内录制，不支持时回退到 Chrome 自带的快捷键设置页。
const CAN_SET_SHORTCUT = typeof chrome.commands?.update === "function";
const SHORTCUT_SETTINGS_URL = "chrome://extensions/shortcuts";
// 与 content.js 顶部的 VERSION 保持一致；不一致时重新注入新脚本
const CONTENT_VERSION = "1.8.1";

const DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  apiKey: "",
  model: DEFAULT_MODEL,
  models: [], // 从接口拉取到的可选模型
  modelCustom: false, // 是否切到手动输入
  showOriginal: true, // 双语对照（关掉则只留译文）
  targetLang: "中文",
  autoRetranslate: true,
  selectionTranslate: true,
  autoSites: [],
};

const CUSTOM_OPTION = "__custom__";

const el = {
  baseUrl: document.getElementById("baseUrl"),
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  modelSelect: document.getElementById("modelSelect"),
  fetchModels: document.getElementById("fetchModels"),
  serviceHead: document.getElementById("serviceHead"),
  servicePanel: document.getElementById("servicePanel"),
  serviceChev: document.getElementById("serviceChev"),
  serviceModel: document.getElementById("serviceModel"),
  shortcutBtn: document.getElementById("shortcutBtn"),
  badge: document.getElementById("badge"),
  targetLang: document.getElementById("targetLang"),
  swSite: document.getElementById("swSite"),
  swOriginal: document.getElementById("swOriginal"),
  swDyn: document.getElementById("swDyn"),
  swSelection: document.getElementById("swSelection"),
  primary: document.getElementById("translate"),
  primaryLabel: document.getElementById("primaryLabel"),
  status: document.getElementById("status"),
  headSub: document.getElementById("headSub"),
};

let settings = { ...DEFAULTS };
let hostname = null;
let pageTranslated = false; // 当前页面是否处于译文状态
let shortcut = "";
let recording = false;

// ---------- 工具 ----------

function setStatus(text, kind = "") {
  el.status.textContent = text;
  el.status.className = `status ${kind}`;
}

function save(patch) {
  Object.assign(settings, patch);
  return chrome.storage.local.set(patch);
}

// 从接口地址推断服务商名，用于顶部徽章
function providerName(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.replace(/^api\./, "");
    return host.split(".")[0] || "自定义";
  } catch {
    return "自定义";
  }
}

function syncHead() {
  const ok = Boolean(settings.apiKey);
  el.headSub.textContent = ok ? `已配置 · ${settings.model}` : "未配置 API Key";
  el.headSub.classList.toggle("warn", !ok);
  el.serviceModel.textContent = settings.model || "未配置";
  el.badge.textContent = providerName(settings.baseUrl);
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// 确保 content script 已注入且是最新版本，返回顶层 frame 上报的信息（含 hostname）
async function ensureContentScript(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    if (resp?.ok && resp.version === CONTENT_VERSION) return resp;
  } catch {
    // 未注入，尝试手动注入
  }
  try {
    // 页面里跑着旧版本时，注入的新脚本会先让旧版本拆掉监听再接管
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js", "selection.js"],
    });
  } catch {
    try {
      // 个别 frame 无权限时，退回只注入顶层
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js", "selection.js"] });
    } catch {
      return null; // chrome:// 等浏览器内部页面无法注入
    }
  }
  return chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 }).catch(() => null);
}

// 接口地址可变，需要按需申请该域名的访问权限（必须由用户操作触发）
async function ensureHostPermission(baseUrl) {
  let origin;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

// ---------- 翻译服务配置 ----------

el.serviceHead.addEventListener("click", () => {
  const opening = el.servicePanel.hasAttribute("hidden");
  el.servicePanel.toggleAttribute("hidden", !opening);
  el.serviceChev.classList.toggle("open", opening);
});

el.baseUrl.addEventListener("change", async () => {
  const value = el.baseUrl.value.trim() || DEFAULT_BASE_URL;
  el.baseUrl.value = value;
  await save({ baseUrl: value });
  syncHead();
  if (!(await ensureHostPermission(value))) {
    setStatus("未授权该接口域名，请求会被浏览器拦截", "err");
  }
});

el.apiKey.addEventListener("change", async () => {
  await save({ apiKey: el.apiKey.value.trim() });
  el.apiKey.value = settings.apiKey;
  syncHead();
});

// 有模型列表时用下拉框，否则用输入框；「自定义模型…」可切回手动输入
function renderModelField() {
  const useSelect = settings.models.length > 0 && !settings.modelCustom;
  el.modelSelect.hidden = !useSelect;
  el.model.hidden = useSelect;

  if (!useSelect) {
    el.model.value = settings.model;
    return;
  }

  const options = settings.models.includes(settings.model)
    ? settings.models
    : [settings.model, ...settings.models];
  el.modelSelect.replaceChildren(
    ...options.map((id) => new Option(id, id)),
    new Option("自定义模型…", CUSTOM_OPTION),
  );
  el.modelSelect.value = settings.model;
}

el.modelSelect.addEventListener("change", async () => {
  if (el.modelSelect.value === CUSTOM_OPTION) {
    await save({ modelCustom: true });
    renderModelField();
    el.model.focus();
    return;
  }
  await save({ model: el.modelSelect.value });
  syncHead();
});

el.model.addEventListener("change", async () => {
  const value = el.model.value.trim() || DEFAULT_MODEL;
  el.model.value = value;
  await save({ model: value });
  syncHead();
});

el.fetchModels.addEventListener("click", async () => {
  el.fetchModels.disabled = true;
  el.fetchModels.textContent = "拉取中…";
  try {
    if (!(await ensureHostPermission(settings.baseUrl))) {
      setStatus("未授权该接口域名，已跳过拉取", "err");
      return;
    }
    const resp = await chrome.runtime.sendMessage({ type: "listModels" });
    if (resp?.error) {
      setStatus(resp.error, "err");
      return;
    }
    await save({ models: resp.models, modelCustom: false });
    renderModelField();
    setStatus(`已拉取 ${resp.models.length} 个模型，点模型框选择`, "ok");
  } catch (e) {
    setStatus(`拉取失败：${e.message}`, "err");
  } finally {
    el.fetchModels.disabled = false;
    el.fetchModels.textContent = "从接口拉取模型列表";
  }
});

// ---------- 开关 ----------

function bindSwitch(node, get, set) {
  node.addEventListener("click", async () => {
    const next = !get();
    node.setAttribute("aria-checked", String(next));
    await set(next);
  });
}

bindSwitch(
  el.swSelection,
  () => settings.selectionTranslate,
  (v) => save({ selectionTranslate: v }),
);

bindSwitch(
  el.swDyn,
  () => settings.autoRetranslate,
  (v) => save({ autoRetranslate: v }),
);

bindSwitch(
  el.swOriginal,
  () => settings.showOriginal,
  async (v) => {
    await save({ showOriginal: v });
    setStatus(v ? "已切换为双语对照，重新翻译后生效" : "已切换为仅译文，重新翻译后生效", "ok");
  },
);

bindSwitch(
  el.swSite,
  () => Boolean(hostname) && settings.autoSites.includes(hostname),
  async (v) => {
    if (!hostname) {
      setStatus("当前页面不支持", "err");
      return;
    }
    const next = v
      ? [...new Set([...settings.autoSites, hostname])]
      : settings.autoSites.filter((h) => h !== hostname);
    await save({ autoSites: next });
    setStatus(v ? `已开启 ${hostname} 自动翻译` : `已关闭 ${hostname} 自动翻译`, "ok");
  },
);

// ---------- 表单 ----------

el.targetLang.addEventListener("change", () => save({ targetLang: el.targetLang.value }));

// ---------- 翻译 / 还原 ----------

function renderPrimary() {
  el.primaryLabel.textContent = pageTranslated ? "↺ 还原原文" : "⇄ 翻译本页";
}

async function syncPageState(tabId) {
  try {
    // 只有顶层 frame 回话，指定 frameId 避免子 frame 干扰
    const resp = await chrome.tabs.sendMessage(tabId, { type: "ping" }, { frameId: 0 });
    pageTranslated = Boolean(resp?.translated);
  } catch {
    pageTranslated = false;
  }
  renderPrimary();
}

// 把扫描/翻译段数拼成一行，方便判断「为什么没翻译到」
function describeResult(r) {
  if (!r) return "";
  const parts = [`翻译 ${r.translated ?? 0} 段`];
  if (r.total !== undefined) parts.push(`页面共 ${r.total} 段文本`);
  if (r.blocked) parts.push(`被标签挡 ${r.blocked} 段${r.blockedTop ? `（${r.blockedTop}）` : ""}`);
  if (r.invisible) parts.push(`不可见 ${r.invisible} 段`);
  if (r.skipped) parts.push(`已是目标语言 ${r.skipped} 段`);
  if (r.cached) parts.push(`复用缓存 ${r.cached} 段`);
  if (r.shadowRoots) parts.push(`${r.shadowRoots} 个 Shadow 组件`);
  if (r.iframeTexts) parts.push(`iframe 内另有 ${r.iframeTexts} 段（已单独翻译）`);
  else if (r.iframes) parts.push(`${r.iframes} 个 iframe`);
  return parts.join(" · ");
}

async function doTranslate() {
  const tab = await currentTab();
  if (!tab?.id) return;

  const info = await ensureContentScript(tab.id);
  if (!info) {
    setStatus("无法翻译此页面（浏览器内部页面不支持）", "err");
    return;
  }
  pageTranslated = Boolean(info.translated);
  renderPrimary();

  el.primary.disabled = true;
  setStatus(pageTranslated ? "还原中…" : "翻译中…");
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: "translatePage",
      targetLang: settings.targetLang,
    });
    if (resp?.error) {
      setStatus(resp.error, "err");
      await syncPageState(tab.id);
    } else if (resp?.restored) {
      pageTranslated = false;
      setStatus("已还原原文", "ok");
    } else if (resp?.translated) {
      pageTranslated = true;
      setStatus(describeResult(resp), "ok");
    } else {
      setStatus(describeResult(resp) || "没有可翻译的文本");
    }
  } catch (e) {
    setStatus(`操作失败：${e.message}`, "err");
  } finally {
    renderPrimary();
    el.primary.disabled = false;
  }
}

async function doRestore() {
  const tab = await currentTab();
  if (!tab?.id) return;
  if (!(await ensureContentScript(tab.id))) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: "restorePage" });
  } catch (e) {
    setStatus(`还原失败：${e.message}`, "err");
    return;
  }
  pageTranslated = false;
  renderPrimary();
  setStatus("已还原原文", "ok");
}

el.primary.addEventListener("click", doTranslate);
document.getElementById("restore").addEventListener("click", doRestore);
document.getElementById("tileRestore").addEventListener("click", doRestore);
document
  .getElementById("tileKey")
  .addEventListener("click", () => chrome.tabs.create({ url: API_KEY_URL }));
document
  .getElementById("tileHelp")
  .addEventListener("click", () => chrome.tabs.create({ url: HELP_URL }));

// ---------- 快捷键设置 ----------

const KEY_NAMES = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Comma: "Comma",
  Period: "Period",
  Space: "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
};

// KeyboardEvent.code -> Chrome commands 支持的主键名，null 表示不支持
function mainKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return KEY_NAMES[code] ?? null;
}

// 把按键事件转成 Chrome 的快捷键字符串，缺少主修饰键时返回 null（继续等待）
function comboFromEvent(e) {
  if (!e.ctrlKey && !e.altKey && !(IS_MAC && e.metaKey)) return null;
  const key = mainKey(e.code);
  if (!key) return null;

  const mods = [];
  if (e.ctrlKey) mods.push(IS_MAC ? "MacCtrl" : "Ctrl");
  if (e.metaKey && IS_MAC) mods.push("Command");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  return [...mods, key].join("+");
}

function formatShortcut(value) {
  if (!value) return "未设置";
  if (!IS_MAC) return value;
  return value
    .replace(/Command/g, "⌘")
    .replace(/MacCtrl/g, "⌃")
    .replace(/Ctrl/g, "⌃")
    .replace(/Alt/g, "⌥")
    .replace(/Shift/g, "⇧")
    .replace(/\+/g, "");
}

function renderPrimaryHint() {
  el.primary.querySelector(".kbd")?.remove();
  if (!shortcut) return;

  const kbd = document.createElement("span");
  kbd.className = "kbd";
  kbd.textContent = formatShortcut(shortcut);
  el.primary.appendChild(kbd);
}

async function renderShortcut() {
  const commands = await chrome.commands.getAll();
  shortcut = commands.find((c) => c.name === COMMAND_NAME)?.shortcut ?? "";
  el.shortcutBtn.textContent = formatShortcut(shortcut);
  renderPrimaryHint();
}

async function applyShortcut(combo) {
  try {
    await chrome.commands.update({ name: COMMAND_NAME, shortcut: combo });
    setStatus(combo ? `快捷键已设为 ${formatShortcut(combo)}` : "已清除快捷键", "ok");
  } catch (e) {
    setStatus(`设置失败：${e.message}（该组合可能已被占用）`, "err");
  }
  await renderShortcut();
}

function stopRecording() {
  recording = false;
  el.shortcutBtn.classList.remove("recording");
  window.removeEventListener("keydown", onRecordKey, true);
}

async function onRecordKey(e) {
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    stopRecording();
    await renderShortcut();
    return;
  }
  if (e.key === "Backspace") {
    stopRecording();
    await applyShortcut("");
    return;
  }

  const combo = comboFromEvent(e);
  if (!combo) return; // 只按了修饰键或不受支持的键，继续等待

  stopRecording();
  await applyShortcut(combo);
}

// Chrome 不允许插件直接打开自身设置页时会抛错，退回复制地址手动打开
async function openShortcutSettings() {
  try {
    await chrome.tabs.create({ url: SHORTCUT_SETTINGS_URL });
    setStatus("已打开 Chrome 快捷键设置页，找到本插件后设置", "ok");
  } catch {
    try {
      await navigator.clipboard.writeText(SHORTCUT_SETTINGS_URL);
      setStatus(`浏览器不允许插件打开该页，地址已复制：${SHORTCUT_SETTINGS_URL}`, "err");
    } catch {
      setStatus(`请手动打开：${SHORTCUT_SETTINGS_URL}`, "err");
    }
  }
}

el.shortcutBtn.addEventListener("click", () => {
  if (!CAN_SET_SHORTCUT) {
    openShortcutSettings();
    return;
  }
  if (recording) {
    stopRecording();
    renderShortcut();
    return;
  }
  recording = true;
  el.shortcutBtn.classList.add("recording");
  el.shortcutBtn.textContent = "按下快捷键…";
  setStatus("按 Esc 取消，Backspace 清除", "");
  window.addEventListener("keydown", onRecordKey, true);
});

// ---------- 初始化 ----------

async function init() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
  if (!Array.isArray(settings.models)) settings.models = [];
  el.baseUrl.value = settings.baseUrl;
  el.apiKey.value = settings.apiKey;
  renderModelField();
  el.targetLang.value = settings.targetLang;
  el.swSelection.setAttribute("aria-checked", String(settings.selectionTranslate));
  el.swDyn.setAttribute("aria-checked", String(settings.autoRetranslate));
  el.swOriginal.setAttribute("aria-checked", String(settings.showOriginal));
  syncHead();

  // 显示真实快捷键（可在面板内点击修改）
  if (!CAN_SET_SHORTCUT) el.shortcutBtn.title = "点击打开 Chrome 快捷键设置页";
  await renderShortcut();

  const tab = await currentTab();
  if (!tab?.id) return;
  const info = await ensureContentScript(tab.id);
  hostname = info?.hostname ?? null;
  pageTranslated = Boolean(info?.translated);
  renderPrimary();
  const on = Boolean(hostname) && settings.autoSites.includes(hostname);
  el.swSite.setAttribute("aria-checked", String(on));
}

init();
