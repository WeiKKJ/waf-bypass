/**
 * Postman 辅助：生成可直接粘贴到 Postman 的 Cookie 头
 *
 * 用法：
 *   node gen-postman-cookie.js              # 刷新 Cookie 并输出
 *   node gen-postman-cookie.js --cookie-only # 只输出 Cookie 串（不刷新）
 *
 * 输出示例：
 *   方式1（推荐，Postman 环境变量）：
 *     pm.environment.set("waf_cookie", "gizqLgxJ4gkhO=xxx; gizqLgxJ4gkhP=yyy; ...");
 *
 *   方式2（直接粘到 Header）：
 *     Cookie: gizqLgxJ4gkhO=xxx; gizqLgxJ4gkhP=yyy; ...
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
];

const TARGET = 'https://dppt.qingdao.chinatax.gov.cn:8443/';
const CDP_PORT = 9500 + Math.floor(Math.random() * 300);
const PROFILE = path.join(os.tmpdir(), 'pm_waf_prof_' + process.pid);
const COOKIE_FILE = path.join(__dirname, 'waf_cookie.txt');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJSON = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, r => {
    let d = ''; r.on('data', c => d += c);
    r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
  }).on('error', rej);
});

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  console.error('未找到 Chrome/Edge');
  process.exit(1);
}

async function refreshCookie() {
  const CHROME = findChrome();
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`, '--disable-gpu', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${PROFILE}`,
    '--disable-blink-features=AutomationControlled', 'about:blank'
  ], { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { try { await getJSON('/json/version'); break; } catch (e) { await sleep(500); } }
    const version = await getJSON('/json/version');
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    let id = 0; const pending = new Map();
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
    const send = (method, params = {}, sessionId) => new Promise(res => {
      const i = ++id; pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    });
    const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
    const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s('Network.enable'); await s('Page.enable');
    await s('Page.navigate', { url: TARGET });
    await sleep(12000);
    const ck = await s('Network.getAllCookies');
    const cookies = (ck.result.cookies || []).filter(c => c.domain.includes('qingdao.chinatax.gov.cn'));
    const str = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    fs.writeFileSync(COOKIE_FILE, str);
    return { str, names: cookies.map(c => c.name) };
  } finally {
    try { chrome.kill(); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
}

(async () => {
  const cookieOnly = process.argv.includes('--cookie-only');

  let str, names;
  if (cookieOnly && fs.existsSync(COOKIE_FILE)) {
    str = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    names = str.split(';').map(s => s.split('=')[0].trim());
    console.error('[模式] 使用已缓存的 Cookie（可能已失效）');
  } else {
    console.error('[模式] 正在用真实 Chrome 通过瑞数挑战...');
    const r = await refreshCookie();
    str = r.str; names = r.names;
    console.error('[模式] 刷新完成');
  }

  console.log('=== 复制下面内容 ===\n');
  console.log('【方式 1】Postman → 右上齿轮 → Environments → 新建环境变量 waf_cookie，值填：');
  console.log(str);
  console.log('\n【方式 2】直接贴进请求的 Cookie Header（整行）：');
  console.log('Cookie: ' + str);
  console.log('\n【Postman 脚本写法】在 Tests 或 Pre-request Script 里：');
  console.log('pm.environment.set("waf_cookie", "' + str + '");');
  console.log('\n【请求 Header 配置】');
  console.log('Cookie: {{waf_cookie}}');
  console.log('\nCookie 名称: ' + names.join(', '));
  console.log('长度: ' + str.length + ' 字符');
  console.log('生成时间: ' + new Date().toLocaleString('zh-CN'));
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
