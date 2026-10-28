#!/usr/bin/env node
/**
 * 瑞数 WAF —— 精简版取 Cookie（单文件，零 npm 依赖）
 *
 * 原理与原项目完全一致，只做一件事：
 *   1. headless Chromium 打开目标 URL → 站点下发 412 挑战页
 *   2. 浏览器自动执行挑战 JS → 生成挑战 Cookie
 *   3. 通过 CDP (Network.getAllCookies) 读出 Cookie
 *
 * 与原 fetch-invoice.js 的差别：
 *   - 不做「纯 HTTP 重放下载」（那部分跟取 Cookie 无关，拆出去更干净）
 *   - 不再每次调用都新开 profile 目录（复用同一个，保留 challenge 状态）
 *   - Chromium 用 --remote-debugging-pipe 以外的常规端口方式保持不变，
 *     但去掉浏览器探测的复杂分支，直接用 CHROME_PATH 环境变量或常见路径
 *
 * 用法：
 *   node waf-token.js "<URL>"              # 打印 Cookie
 *   node waf-token.js "<URL>" --json       # JSON 输出
 *
 * 环境变量：
 *   CHROME_PATH   Chromium 可执行文件路径（不设则自动探测）
 *   WAF_UA        自定义 User-Agent
 */

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── WebSocket 自举（Node 22 内置；Node 20 需 flag）──
if (typeof WebSocket === 'undefined') {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major >= 20 && !process.env.__WAF_WS_BOOTSTRAP) {
    const { spawn: sp } = require('child_process');
    const child = sp(process.execPath,
      ['--experimental-websocket', __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, __WAF_WS_BOOTSTRAP: '1' } });
    child.on('exit', code => process.exit(code === null ? 1 : code));
    return;
  }
  try {
    global.WebSocket = require('ws');
  } catch (e) {
    console.error('需要 Node.js 22+（或 npm i ws）');
    process.exit(1);
  }
}

const CHALLENGE_WAIT_MS = parseInt(process.env.WAF_WAIT_MS || '14000', 10);
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────── 浏览器定位 ───────────────────

function findChromium() {
  if (process.env.CHROME_PATH) {
    if (!fs.existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 不存在: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const candidates = [
    // Linux (alpine / debian / ubuntu)
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // Playwright 镜像（万一还基于它构建）
    ...(() => {
      try {
        const root = '/ms-playwright';
        if (!fs.existsSync(root)) return [];
        return fs.readdirSync(root).filter(d => d.startsWith('chromium-'))
          .map(d => path.join(root, d, 'chrome-linux', 'chrome'));
      } catch (e) { return []; }
    })(),
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Windows
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  ];
  const hit = candidates.find(p => p && fs.existsSync(p));
  if (!hit) throw new Error('未找到 Chromium，请设置 CHROME_PATH 环境变量');
  return hit;
}

// ─────────────────── CDP 最小客户端 ───────────────────

function httpJson(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(2000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}

/**
 * 打开 URL 等挑战 JS 跑完，取回该域名的 Cookie
 */
async function grabCookie(browserPath, targetUrl, ua) {
  const port = 9222 + Math.floor(Math.random() * 800);
  const profile = path.join(os.tmpdir(), `waf_prof_${process.pid}`);

  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    '--disable-blink-features=AutomationControlled',
    '--window-size=1920,1080',
    'about:blank',
  ];

  const chrome = spawn(browserPath, args, { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 80; i++) {
      try { version = await httpJson(port, '/json/version'); break; }
      catch (e) { await sleep(500); }
    }
    if (!version) throw new Error('Chromium 启动超时 / CDP 未就绪');

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const responses = [];

    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
      ws.onclose = () => rej(new Error('CDP WebSocket 意外关闭'));
    });

    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      else if (m.method === 'Network.responseReceived') responses.push(m.params.response);
    };

    const send = (method, params = {}, sessionId) => new Promise(res => {
      const i = ++msgId; pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });

    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);

    await s('Network.enable');
    await s('Page.enable');
    await s('Runtime.enable');
    await s('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await s('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

    // 关键：抹掉 HeadlessChrome 标识
    await s('Network.setUserAgentOverride', {
      userAgent: ua,
      platform: 'Windows',
      acceptLanguage: 'zh-CN,zh;q=0.9',
    });

    await s('Page.navigate', { url: targetUrl });
    await sleep(CHALLENGE_WAIT_MS);

    const ck = await s('Network.getAllCookies');
    const host = new URL(targetUrl).hostname;
    const cookies = (ck.result.cookies || []).filter(c => c.domain.includes(host));

    const pathname = new URL(targetUrl).pathname;
    const chain = responses.filter(r => r.url.includes(pathname))
      .map(r => `${r.status} ${r.mimeType}`);

    ws.close();
    return {
      cookie: cookies.map(c => `${c.name}=${c.value}`).join('; '),
      names: cookies.map(c => c.name),
      chain,
    };
  } finally {
    try { chrome.kill(); } catch (e) {}
    try {
      await new Promise(resolve => {
        if (chrome.exitCode !== null) return resolve();
        chrome.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
    } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); }
    catch (e) { /* profile 残留不影响功能 */ }
  }
}

// ─────────────────── 纯 HTTP 重放（拿 Cookie 后立刻用掉）───────────────────

async function replay(url, cookie, ua) {
  const res = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'User-Agent': ua,
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': new URL(url).origin + '/',
    },
    redirect: 'follow',
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct: res.headers.get('content-type') || '', buf };
}

// ─────────────────── 主流程 ───────────────────

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const url = argv.find(a => !a.startsWith('--'));
  if (!url) {
    console.log('用法: node waf-token.js "<URL>" [--json]');
    console.log('环境变量: CHROME_PATH / WAF_UA / WAF_WAIT_MS');
    process.exit(0);
  }

  const ua = process.env.WAF_UA || DEFAULT_UA;
  const browser = findChromium();

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await grabCookie(browser, url, ua);
      if (!r.cookie) throw new Error('未取得 Cookie');
      if (r.chain.length) console.error(`[挑战] ${r.chain.join(' → ')}`);

      // 立刻用掉（Cookie 只有 1~3 分钟有效期）
      const h = await replay(url, r.cookie, ua);
      console.error(`[重放] HTTP ${h.status} ${h.ct} ${h.buf.length} 字节`);

      const out = {
        ok: h.status === 200 && h.buf.subarray(0, 5).toString() === '%PDF-',
        status: h.status,
        cookie: r.cookie,
        names: r.names,
        bytes: h.buf.length,
        contentType: h.ct,
      };
      if (asJson) console.log(JSON.stringify(out));
      else console.log(r.cookie);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[重试] 第${attempt}次失败：${e.message}`);
      await sleep(1500);
    }
  }
  throw lastErr;
}

main().catch(e => { console.error('\n失败:', e.message); process.exit(1); });
