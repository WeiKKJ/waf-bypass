#!/usr/bin/env node
/**
 * 瑞数 WAF —— 精简版 HTTP 服务（纯 Node，零外部依赖）
 *
 * 取代原项目的 api.py + FastAPI + uvicorn + httpx：
 *   Node 22 自带 http 模块和 fetch，一个进程即可。
 *
 * 流程（原 api.py 的逻辑一致）：
 *   1. 直接 GET（不带 Cookie）
 *   2. 412 → 试该域名缓存的 Cookie
 *   3. 仍 412 → 现场启动 Chromium 采集一次新 Cookie，重放
 *   4. 还失败就放弃（不死循环）
 *
 * 与原实现的差异：
 *   - **浏览器常驻**：原版每次请求都 spawn 一次 Chromium（启动 2~4s + 等 14s），
 *     这里浏览器进程复用，每个请求只新建一个隔离 target，快 ~10 倍。
 *   - **无子进程**：原版 api.py 通过 subprocess 调 fetch-invoice.js，
 *     再用正则从 stdout 里抠 Cookie。这里 CDP 直接在进程内调用。
 *   - **无 Python**：不需要 python3 / pip / fastapi / uvicorn / httpx。
 *
 * 接口：
 *   GET  /fetch?url=...     返回 PDF 流
 *   POST /fetch  {"url":...}
 *   GET  /check?url=...     只探测状态
 *   GET  /token?url=...     只返回 Cookie（不下载文件）
 *   GET  /health
 *   GET  /cache             查看 Cookie 缓存
 *   DELETE /cache[?domain=]
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8000', 10);
const HEAL_TIMEOUT = parseInt(process.env.WAF_HEAL_TIMEOUT || '120', 10);
const CHALLENGE_WAIT_MS = parseInt(process.env.WAF_WAIT_MS || '14000', 10);
const DEFAULT_UA = process.env.WAF_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────── 浏览器定位 ───────────────────

function findChromium() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 不存在: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const cands = [
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  ];
  const hit = cands.find(p => p && fs.existsSync(p));
  if (!hit) throw new Error('未找到 Chromium，请设置 CHROME_PATH');
  return hit;
}

// ─────────────────── 常驻浏览器 + CDP ───────────────────

class Browser {
  constructor() {
    this.proc = null;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
    this.port = 0;
    this.ready = null;
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }

  async _start() {
    const bin = findChromium();
    this.port = 9222 + Math.floor(Math.random() * 800);
    this.profile = path.join(os.tmpdir(), `waf_prof_srv_${process.pid}`);

    const args = [
      '--headless=new',
      `--remote-debugging-port=${this.port}`,
      '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      `--user-data-dir=${this.profile}`,
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      'about:blank',
    ];

    this.proc = spawn(bin, args, { stdio: 'ignore' });

    let version = null;
    for (let i = 0; i < 80; i++) {
      try {
        version = await this._httpJson('/json/version');
        break;
      } catch (e) { await sleep(500); }
    }
    if (!version) throw new Error('Chromium 启动超时 / CDP 未就绪');

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
    });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    };
    this.ws = ws;
    return this;
  }

  _httpJson(p) {
    return new Promise((res, rej) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: p }, r => {
        let d = ''; r.on('data', c => d += c);
        r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
      });
      req.on('error', rej);
      req.setTimeout(2000, () => { req.destroy(); rej(new Error('timeout')); });
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((res, rej) => {
      const i = ++this.msgId;
      const timer = setTimeout(() => {
        this.pending.delete(i);
        rej(new Error(`CDP 超时: ${method}`));
      }, HEAL_TIMEOUT * 1000);
      this.pending.set(i, m => { clearTimeout(timer); res(m); });
      this.ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
  }

  /**
   * 在独立 browser context（= 独立 cookie 隔离区）里打开 URL，
   * 等挑战 JS 跑完，读回该域名的 Cookie。
   */
  async harvest(targetUrl, ua) {
    await this.start();

    const { result: { browserContextId } } = await this.send(
      'Target.createBrowserContext', { disposeOnDetach: false });

    const { result: { targetId } } = await this.send(
      'Target.createTarget', { url: 'about:blank', browserContextId });

    const { result: { sessionId } } = await this.send(
      'Target.attachToTarget', { targetId, flatten: true });

    const s = (m, p) => this.send(m, p, sessionId);

    try {
      await s('Network.enable');
      await s('Page.enable');
      await s('Runtime.enable');
      await s('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
      await s('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
      await s('Network.setUserAgentOverride', {
        userAgent: ua, platform: 'Windows', acceptLanguage: 'zh-CN,zh;q=0.9',
      });

      await s('Page.navigate', { url: targetUrl });
      await sleep(CHALLENGE_WAIT_MS);

      const ck = await s('Network.getAllCookies');
      const host = new URL(targetUrl).hostname;
      const cookies = (ck.result.cookies || []).filter(c => c.domain.includes(host));

      return {
        cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
        names: cookies.map(c => c.name),
      };
    } finally {
      // 关掉 target 并销毁 context，避免 cookie 泄漏到下一次请求
      await this.send('Target.closeTarget', { targetId }).catch(() => {});
      await this.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }
  }

  async stop() {
    try { this.proc && this.proc.kill(); } catch (e) {}
    try { this.ws && this.ws.close(); } catch (e) {}
  }
}

const browser = new Browser();

// ─────────────────── Cookie 缓存（按域名，内存）───────────────────

const cache = new Map();          // host -> {cookie, at}
const domainLocks = new Map();    // host -> Promise（同域名串行，避免并发起多个采集）

function domainOf(url) {
  try { return new URL(url).host.toLowerCase(); }
  catch (e) { throw new Error('URL 格式不正确'); }
}

function getCached(host) {
  const e = cache.get(host);
  if (!e) return '';
  // Cookie 实测有效期 1~3 分钟，这里保守按 90s 过期
  if (Date.now() - e.at > 90_000) { cache.delete(host); return ''; }
  return e.cookie;
}

function setCached(host, cookie) { cache.set(host, { cookie, at: Date.now() }); }

// ─────────────────── HTTP 层 ───────────────────

async function doGet(url, cookie) {
  const headers = {
    'User-Agent': DEFAULT_UA,
    'Accept': 'application/pdf,application/octet-stream,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': new URL(url).origin + '/',
  };
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    ct: res.headers.get('content-type') || '',
    buf,
  };
}

function isPdf(buf) { return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-'; }

/**
 * 核心：直接 GET → 412 试缓存 → 仍 412 现场采集 → 重放（最多一次）
 */
async function fetchWithHeal(url, { wantBody = true } = {}) {
  const host = domainOf(url);
  const steps = [];

  let r = await doGet(url, '');
  steps.push({ step: 'direct', status: r.status });
  if (r.status !== 412) return { resp: r, steps, cookieLen: 0 };

  const cached = getCached(host);
  if (cached) {
    const r2 = await doGet(url, cached);
    steps.push({ step: 'cached_cookie', status: r2.status });
    if (r2.status !== 412) return { resp: r2, steps, cookieLen: cached.length };
    cache.delete(host);
  }

  // 同域名串行
  const prev = domainLocks.get(host) || Promise.resolve();
  let release;
  domainLocks.set(host, new Promise(r => { release = r; }));
  await prev;

  try {
    const fresh = await browser.harvest(url, DEFAULT_UA);
    if (!fresh.cookie) {
      steps.push({ step: 'give_up', reason: '未取得 Cookie' });
      return { resp: r, steps, cookieLen: 0 };
    }
    setCached(host, fresh.cookie);

    const r3 = await doGet(url, fresh.cookie);
    steps.push({ step: 'healed', status: r3.status });
    if (r3.status === 412) {
      cache.delete(host);
      steps.push({ step: 'give_up', reason: '新 Cookie 仍被拒(412)' });
    }
    return { resp: r3, steps, cookieLen: fresh.cookie.length };
  } finally {
    release();
    if (domainLocks.get(host) && domainLocks.get(host).toString() === release.toString()) {
      // 简单清理：下一个请求会覆盖
    }
  }
}

// ─────────────────── HTTP 服务 ───────────────────

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); });
    req.on('end', () => res(d));
    req.on('error', rej);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  try {
    if (p === '/' || p === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'waf-token-slim',
        strategy: '直接 GET → 412 试域名缓存 Cookie → 仍 412 现场采集一次重放（不死循环）',
        persistence: '不落盘：PDF 仅在内存中返回，Cookie 按域名缓存在进程内存',
        cached_domains: [...cache.keys()],
      });
    }

    if (p === '/cache') {
      const items = {};
      for (const [h, e] of cache) {
        items[h] = { cookie_len: e.cookie.length, age_seconds: +((Date.now() - e.at) / 1000).toFixed(1) };
      }
      return sendJson(res, 200, { count: Object.keys(items).length, domains: items });
    }

    if (p === '/cache' && req.method === 'DELETE') {
      const d = u.searchParams.get('domain');
      if (d) cache.delete(d.toLowerCase()); else cache.clear();
      return sendJson(res, 200, { cleared: d || '*', remaining: [...cache.keys()] });
    }

    // POST /fetch
    if (p === '/fetch' && req.method === 'POST') {
      const raw = await readBody(req);
      let url;
      try { url = JSON.parse(raw).url; } catch (e) { return sendJson(res, 400, { error: 'JSON 格式错误' }); }
      return await handleFetch(res, url);
    }

    // GET /fetch?url=  |  /check?url=  |  /token?url=
    if (p === '/fetch' || p === '/check' || p === '/token') {
      const url = u.searchParams.get('url');
      if (!url) return sendJson(res, 400, { error: '缺少 url 参数' });
      return await handleFetch(res, url, p === '/check' ? 'check' : (p === '/token' ? 'token' : 'pdf'));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

async function handleFetch(res, url, mode = 'pdf') {
  const r = await fetchWithHeal(url);
  const ok = r.resp.status === 200 && isPdf(r.resp.buf);

  if (mode === 'check') {
    return sendJson(res, 200, {
      url, status: r.resp.status, content_type: r.resp.ct,
      length: r.resp.buf.length, is_pdf: ok, steps: r.steps,
    });
  }

  if (mode === 'token') {
    const host = domainOf(url);
    const cookie = getCached(host);
    return sendJson(res, 200, {
      url, status: r.resp.status, cookie_len: cookie.length,
      cookie, steps: r.steps,
    });
  }

  if (!ok) {
    return sendJson(res, r.resp.status >= 400 ? r.resp.status : 502, {
      ok: false, status: r.resp.status, content_type: r.resp.ct,
      length: r.resp.buf.length, steps: r.steps,
      hint: '目标未返回 PDF（挑战未通过或 URL 失效）',
    });
  }

  const body = r.resp.buf;
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': body.length,
    'X-Waf-Status': String(r.resp.status),
    'X-Waf-Steps': JSON.stringify(r.steps),
  });
  res.end(body);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[waf-token-slim] 监听 :${PORT}`);
  console.log('[waf-token-slim] 浏览器常驻，首次请求时惰性启动');
});

// 优雅退出，清理 profile
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await browser.stop();
    try { fs.rmSync(browser.profile || '', { recursive: true, force: true }); } catch (e) {}
    process.exit(0);
  });
}
