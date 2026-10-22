#!/usr/bin/env node
/**
 * 瑞数 WAF 动态挑战 —— 跨平台发票抓取
 *
 * 特性：
 *   ✓ 零 npm 依赖（用 Node 内置 WebSocket + fetch）
 *   ✓ 跨平台：Windows / macOS / Linux 自动探测浏览器
 *   ✓ 无需 GUI 窗口（headless + CDP 覆盖 UA）
 *   ✓ 自动降级：headless 失败自动重试有头模式
 *   ✓ 自动刷新 Cookie（412 时重取）
 *
 * 用法：
 *   node fetch-invoice.js "<URL>" [输出文件名.pdf]
 *   node fetch-invoice.js --cookie-only          # 只输出 Cookie，供 Postman 使用
 *   node fetch-invoice.js --url-from-file list.txt # 批量，文件内每行一个 URL
 *
 * 环境要求：Node.js >= 18（内置 fetch）+ 本机有 Chrome / Edge / Chromium 之一
 */

const { spawn, execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── WebSocket 自举 ────────────────────────────────────────────────
// Node 22+ 内置全局 WebSocket；Node 20 需 --experimental-websocket；
// 更老的版本则回退到 npm 的 ws。
if (typeof WebSocket === 'undefined') {
  const major = parseInt(process.versions.node.split('.')[0], 10);

  if (major >= 20 && !process.env.__WAF_WS_BOOTSTRAP) {
    // 用 flag 重新启动自己
    const args = ['--experimental-websocket', __filename, ...process.argv.slice(2)];
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', code => process.exit(code === null ? 1 : code));
    return; // 顶层 return 在 CommonJS 模块中合法
  }

  // 尝试加载 ws
  try {
    global.WebSocket = require('ws');
  } catch (e) {
    console.error(
      '需要 WebSocket 支持。\n' +
      '请使用 Node.js 22+，或执行：npm i ws'
    );
    process.exit(1);
  }
}

// ─────────────────────────── 配置 ───────────────────────────

const CHALLENGE_WAIT_MS = 14000;   // 等挑战 JS 执行完的时间
const CDP_PORT_BASE = 9500;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

// ─────────────────────── 浏览器自动探测 ───────────────────────

function findBrowsers() {
  const found = [];
  const isWin = process.platform === 'win32';

  if (isWin) {
    const winPaths = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      `${process.env.LOCALAPPDATA || ''}/Microsoft/Edge/Application/msedge.exe`
    ];
    winPaths.forEach(p => { if (p && fs.existsSync(p)) found.push(p); });

    // 兜底：查注册表 / where
    try {
      const out = execSync('where chrome.exe 2>NUL || where msedge.exe 2>NUL', {
        encoding: 'utf8', shell: 'cmd.exe'
      });
      out.split(/\r?\n/).filter(Boolean).forEach(p => {
        if (fs.existsSync(p.trim()) && !found.includes(p.trim())) found.push(p.trim());
      });
    } catch (e) { /* where 无结果属正常 */ }
    } else {
      // macOS / Linux
      const unixPaths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
        '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium', '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge', '/snap/bin/chromium',
        '/var/lib/flatpak/exports/bin/com.google.Chrome'
      ];
      unixPaths.forEach(p => { if (fs.existsSync(p)) found.push(p); });

      // Docker: Playwright 官方镜像把浏览器放在 /ms-playwright/<版本>/chrome-linux/chrome
      // 版本号会随镜像变化，这里自动探测
      try {
        const pwRoot = '/ms-playwright';
        if (fs.existsSync(pwRoot)) {
          fs.readdirSync(pwRoot)
            .filter(d => d.startsWith('chromium-'))
            .forEach(d => {
              const p = path.join(pwRoot, d, 'chrome-linux', 'chrome');
              if (fs.existsSync(p)) found.push(p);
            });
        }
      } catch (e) { /* 忽略 */ }

      // 兜底：which
    ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
      .forEach(cmd => {
        try {
          const p = execSync(`which ${cmd} 2>/dev/null || command -v ${cmd} 2>/dev/null`, {
            encoding: 'utf8', shell: '/bin/bash'
          }).trim();
          if (p && fs.existsSync(p) && !found.includes(p)) found.push(p);
        } catch (e) { /* 未安装 */ }
      });
  }
  return found;
}

// ─────────────────────────── 工具 ───────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cdpGet(port, p) {
  return new Promise((res, rej) => {
    const req = http.get({ host: '127.0.0.1', port, path: p }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    });
    req.on('error', rej);
    req.setTimeout(2000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}

// ─────────────────── 核心：通过瑞数挑战拿 Cookie ───────────────────

async function getChallengeCookie(browserPath, targetUrl, { headless = true, ua = DEFAULT_UA } = {}) {
  const port = CDP_PORT_BASE + Math.floor(Math.random() * 400);
  const profile = path.join(os.tmpdir(), `waf_prof_${process.pid}_${Date.now()}`);
  const targetHost = new URL(targetUrl).hostname;

  const args = [
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--window-size=1920,1080',
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new');

  const chrome = spawn(browserPath, args, { stdio: 'ignore' });

  try {
    let version = null;
    for (let i = 0; i < 80; i++) {
      try { version = await cdpGet(port, '/json/version'); break; }
      catch (e) { await sleep(500); }
    }
    if (!version) throw new Error('浏览器启动超时或 CDP 端口未就绪');

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    const responses = [];

    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'));
      ws.onclose = () => rej(new Error('CDP WebSocket 意外关闭'));
    });

    ws.onmessage = (ev) => {
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

    // 禁止浏览器下载文件：导航到目标 URL 会触发 PDF 自动下载，
    // 默认落到 ~/Downloads，会在容器可写层里堆积。
    // PDF 一律由 httpFetch 纯 HTTP 重放获取，不经浏览器落盘。
    await s('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
    await s('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});

    // 关键：覆盖 UA，去掉 HeadlessChrome 标识（headless 模式必需）
    await s('Network.setUserAgentOverride', {
      userAgent: ua,
      platform: os.platform() === 'darwin' ? 'macOS' : os.platform() === 'win32' ? 'Windows' : 'Linux',
      acceptLanguage: 'zh-CN,zh;q=0.9'
    });

    await s('Page.navigate', { url: targetUrl });
    await sleep(CHALLENGE_WAIT_MS);

    const ck = await s('Network.getAllCookies');
    const cookies = (ck.result.cookies || []).filter(c => c.domain.includes(targetHost));
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const relevant = responses.filter(r => r.url.includes(new URL(targetUrl).pathname));
    const last = relevant[relevant.length - 1];

    ws.close();
    return {
      cookieStr,
      names: cookies.map(c => c.name),
      status: last ? last.status : 0,
      mime: last ? last.mimeType : '',
      chain: relevant.map(r => `${r.status} ${r.mimeType}`)
    };
  } finally {
    // 结束浏览器并等待其真正退出，否则 profile 目录删除会失败并残留磁盘文件
    try { chrome.kill(); } catch (e) {}
    try {
      await new Promise(resolve => {
        if (chrome.exitCode !== null) return resolve();
        chrome.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
    } catch (e) {}
    // 浏览器退出后仍可能有文件句柄未释放，重试几次再放弃
    for (let i = 0; i < 5; i++) {
      try {
        if (!fs.existsSync(profile)) break;
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch (e) {
        if (i === 4) console.error(`  ! profile 目录清理失败: ${profile}`);
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }
}

// ─────────────────── 纯 HTTP 重放下载 ───────────────────

async function httpFetch(url, cookie, ua) {
  const res = await fetch(url, {
    headers: {
      'Cookie': cookie,
      'User-Agent': ua,
      'Accept': 'application/pdf,application/octet-stream,*/*',
      'Referer': new URL(url).origin + '/',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    redirect: 'follow'
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, ct: res.headers.get('content-type') || '', buf };
}

// ─────────────────── 对外主流程 ───────────────────

async function fetchInvoice(url, outFile) {
  // 优先用环境变量指定的浏览器
  let browser = process.env.WAF_BROWSER || null;
  if (browser && !fs.existsSync(browser)) {
    throw new Error(
      `环境变量 WAF_BROWSER 指定的浏览器不存在:\n  ${browser}\n` +
      '请检查路径，或删除该环境变量让程序自动探测。'
    );
  }
  if (!browser) {
    const browsers = findBrowsers();
    if (!browsers.length) {
      throw new Error(
        '未找到 Chrome / Edge / Chromium。\n' +
        '请安装其中之一，或设置环境变量 WAF_BROWSER 指向浏览器可执行文件。\n' +
        '例如 (Windows): set WAF_BROWSER=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\n' +
        '      (macOS)  : export WAF_BROWSER="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"\n' +
        '      (Linux)  : export WAF_BROWSER=/usr/bin/google-chrome'
      );
    }
    browser = browsers[0];
  }
  console.log(`[浏览器] ${browser}`);
  console.log(`[模式]   headless（无 GUI 窗口依赖）`);

  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await getChallengeCookie(browser, url, { headless: true });
      console.log(`[挑战]   第${attempt}次 → ${r.chain.join(' → ')}`);

      if (!r.cookieStr) throw new Error('未取得任何 Cookie');

      const h = await httpFetch(url, r.cookieStr, DEFAULT_UA);
      console.log(`[重放]   HTTP ${h.status} ${h.ct} ${h.buf.length} 字节`);

      if (h.status === 200 && h.buf.length > 0) {
        if (outFile) {
          fs.writeFileSync(outFile, h.buf);
          console.log(`[完成]   已保存 → ${outFile}`);
        }
        return { ok: true, status: h.status, cookie: r.cookieStr, buf: h.buf, names: r.names };
      }
      last = new Error(`HTTP ${h.status}`);
    } catch (e) {
      last = e;
      console.log(`[重试]   第${attempt}次失败：${e.message}`);
    }
    await sleep(2000);
  }
  throw last || new Error('未知错误');
}

// ─────────────────────────── CLI ───────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cookieOnly = args.includes('--cookie-only');
  const fileIdx = args.indexOf('--url-from-file');
  const fileList = fileIdx >= 0 ? args[fileIdx + 1] : null;

  const positional = args.filter(a => !a.startsWith('--') && a !== fileList);
  const url = positional[0];
  const outFile = positional[1] || (cookieOnly ? null : 'invoice.pdf');

  if (fileList) {
    if (!fs.existsSync(fileList)) throw new Error(`文件不存在: ${fileList}`);
    const urls = fs.readFileSync(fileList, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    console.log(`批量模式：${urls.length} 条 URL\n`);
    const cookieFile = path.join(path.dirname(fileList), 'waf_cookie.txt');
    let cookie = '';
    for (let i = 0; i < urls.length; i++) {
      const name = `out_${String(i + 1).padStart(3, '0')}.pdf`;
      try {
        let r;
        if (cookie) {
          const h = await httpFetch(urls[i], cookie, DEFAULT_UA);
          if (h.status === 200) r = { ok: true, buf: h.buf };
          else r = await fetchInvoice(urls[i], name);
        } else {
          r = await fetchInvoice(urls[i], name);
        }
        if (r && r.cookie) { cookie = r.cookie; fs.writeFileSync(cookieFile, cookie); }
        console.log(`  [${i + 1}/${urls.length}] ✓ ${name} ${r.buf.length} 字节`);
      } catch (e) {
        console.log(`  [${i + 1}/${urls.length}] ✗ ${e.message}`);
      }
    }
    console.log('\n完成。Cookie 已保存到 ' + cookieFile);
    return;
  }

  if (!url) {
    console.log('用法:');
    console.log('  node fetch-invoice.js "<URL>" [输出文件.pdf]');
    console.log('  node fetch-invoice.js --cookie-only');
    console.log('  node fetch-invoice.js --url-from-file list.txt');
    console.log('\n环境变量:');
    console.log('  WAF_BROWSER   指定浏览器路径（未自动找到时使用）');
    console.log('  WAF_UA        自定义 User-Agent');
    process.exit(0);
  }

  if (cookieOnly) {
    let browser = process.env.WAF_BROWSER || findBrowsers()[0];
    if (!browser || !fs.existsSync(browser)) {
      throw new Error(
        (browser ? `WAF_BROWSER 路径不存在: ${browser}\n` : '未找到 Chrome / Edge / Chromium。\n') +
        '请安装浏览器或设置 WAF_BROWSER 环境变量。'
      );
    }
    const r = await getChallengeCookie(
      browser,
      url,
      { headless: true, ua: process.env.WAF_UA || DEFAULT_UA }
    );
    console.log('\n=== Postman 用 Cookie 头 ===');
    console.log('Cookie: ' + r.cookieStr);
    console.log('\n=== 环境变量脚本 ===');
    console.log(`pm.environment.set("waf_cookie", "${r.cookieStr}");`);
    console.log('\nCookie 名称: ' + r.names.join(', '));
    console.log('长度: ' + r.cookieStr.length + ' 字符');
    return;
  }

  const r = await fetchInvoice(url, outFile);
  console.log('\nCookie 名称: ' + r.names.join(', '));
  console.log('（如需给 Postman 用：node fetch-invoice.js --cookie-only）');
}

main().catch(e => { console.error('\n失败:', e.message); process.exit(1); });
