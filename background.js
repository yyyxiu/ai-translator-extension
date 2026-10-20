// background.js — service worker，统一调用模型接口（绕开网页 CORS 限制）

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_MODEL = "deepseek-chat";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "translate") {
    translate(msg.text, msg.targetLang)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true; // 异步响应，保持消息通道
  }
  if (msg.type === "listModels") {
    listModels()
      .then(sendResponse)
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "busy") {
    if (msg.on) startBusy();
    else stopBusy();
    sendResponse({ ok: true });
  }
});

// 快捷键触发整页翻译
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "translate-page") return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const { targetLang = "中文" } = await chrome.storage.local.get("targetLang");
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "translatePage", targetLang });
  } catch {
    // 浏览器内部页面无法注入，忽略
  }
});

// ---------- 配置 ----------

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["baseUrl", "apiKey", "model"]);
  return {
    baseUrl: cfg.baseUrl?.trim() || DEFAULT_BASE_URL,
    apiKey: cfg.apiKey?.trim() || "",
    model: cfg.model?.trim() || DEFAULT_MODEL,
  };
}

// 兼容用户填到 /v1、根域名、或完整 endpoint 三种写法
function apiRoot(baseUrl) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return base.replace(/\/chat\/completions$/, "");
}

function buildEndpoint(baseUrl, path) {
  return `${apiRoot(baseUrl)}${path}`;
}

// ---------- 接口调用 ----------

// fetch 不带超时会永远挂起，连带消息通道一起挂死；
// 超时后转成可读错误，让上层能正常回话
async function fetchWithTimeout(url, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`模型接口 ${Math.round(timeoutMs / 1000)} 秒内没有响应，请重试`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const TRANSLATE_TIMEOUT = 120_000; // 整批翻译可能较慢，给足余量
const LIST_TIMEOUT = 30_000;

async function translate(text, targetLang) {
  const { baseUrl, apiKey, model } = await loadConfig();
  if (!apiKey) return { error: "未配置 API Key，请点击插件图标填写" };

  const resp = await fetchWithTimeout(buildEndpoint(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: `你是专业的翻译引擎，把用户输入翻译成${targetLang}。规则：
1. 只输出译文，不要解释、注释、原文或任何附加内容。
2. 输入中的分隔符 [[[SPLIT]]] 必须原样保留，不得翻译或遗漏。
3. 保持原文的换行和段落结构。`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.3,
      stream: false,
    }),
  }, TRANSLATE_TIMEOUT);

  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { error: data?.error?.message || `请求失败：HTTP ${resp.status}` };
  }
  return { text: data?.choices?.[0]?.message?.content ?? "" };
}

async function listModels() {
  const { baseUrl, apiKey } = await loadConfig();
  if (!apiKey) return { error: "请先填写 API Key" };

  const resp = await fetchWithTimeout(buildEndpoint(baseUrl, "/models"), {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, LIST_TIMEOUT);
  const data = await resp.json().catch(() => null);
  if (!resp.ok) {
    return { error: data?.error?.message || `拉取失败：HTTP ${resp.status}` };
  }

  const models = (data?.data ?? []).map((m) => m.id).filter(Boolean);
  return models.length ? { models } : { error: "接口未返回模型列表" };
}

// ---------- 图标：翻译时转圈，结束后恢复 ----------

const ACCENT = "#f0386e";
const ICON_SIZES = [16, 32];
const SPIN_FRAMES = 12; // 转一圈的帧数
const SPIN_INTERVAL = 90; // 每帧毫秒

let spinTimer = null;
let spinFrame = 0;
let iconUsable = true;
let busyCount = 0; // 可能同时有多个标签页在翻译

// 静态图标：粉底 + 三条白色横线
function drawLogo(size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.roundRect(size * 0.08, size * 0.08, size * 0.84, size * 0.84, size * 0.24);
  ctx.fill();

  ctx.fillStyle = "#fff";
  const bar = Math.max(1, Math.round(size * 0.08));
  const left = Math.round(size * 0.28);
  ctx.fillRect(left, Math.round(size * 0.32), Math.round(size * 0.44), bar);
  ctx.fillRect(left, Math.round(size * 0.46), Math.round(size * 0.44), bar);
  ctx.fillRect(left, Math.round(size * 0.6), Math.round(size * 0.28), bar);
  return ctx.getImageData(0, 0, size, size);
}

// 转圈图标：一段带缺口的圆弧
function drawSpinner(size, angle) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");

  ctx.translate(size / 2, size / 2);
  ctx.rotate(angle);
  ctx.lineWidth = Math.max(2, size * 0.13);
  ctx.lineCap = "round";
  ctx.strokeStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.33, 0, Math.PI * 1.5);
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

function iconData(draw) {
  return Object.fromEntries(ICON_SIZES.map((size) => [size, draw(size)]));
}

async function setIcon(draw) {
  if (!iconUsable) return;
  try {
    await chrome.action.setIcon({ imageData: iconData(draw) });
  } catch (e) {
    iconUsable = false; // 绘制不可用，退回默认图标，不再反复尝试
    console.warn("[AI 翻译] 图标绘制不可用：", e.message);
  }
}

function startBusy() {
  busyCount++;
  if (spinTimer) return;
  chrome.action.setTitle({ title: "AI 整页翻译 · 正在翻译…" });

  const tick = () => {
    spinFrame = (spinFrame + 1) % SPIN_FRAMES;
    setIcon((size) => drawSpinner(size, (spinFrame * 2 * Math.PI) / SPIN_FRAMES));
    if (!iconUsable) chrome.action.setBadgeText({ text: "…" });
  };
  tick();
  spinTimer = setInterval(tick, SPIN_INTERVAL);
}

function stopBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (busyCount > 0 || !spinTimer) return;

  clearInterval(spinTimer);
  spinTimer = null;
  chrome.action.setTitle({ title: "AI 整页翻译" });
  chrome.action.setBadgeText({ text: "" });
  setIcon(drawLogo);
}

setIcon(drawLogo); // service worker 启动时先画上静态图标

