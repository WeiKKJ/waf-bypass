#!/usr/bin/env node
/**
 * 瑞数 WAF —— 纯 HTTP 发票下载器（零浏览器依赖）
 *
 * 核心思路：WAF 挑战只在「取 Cookie」那一步需要 JS 执行环境；
 * 一旦拿到有效 Cookie，后续请求全部是普通 HTTP。
 * 因此把流程拆成两段：
 *   1. 取 Cookie —— 手动跑一次 `fetch-invoice.js --cookie-only`，存入 waf_cookie.txt
 *   2. 纯 HTTP 下载 —— 本脚本，全程 requests/fetch 语义，不启动任何浏览器
 *
 * 适合：服务端 / 定时任务 / 容器 / CI —— 只要 waf_cookie.txt 还没过期。
 *
 * 用法：
 *   node http-client.js "<URL>"                          # 下载
 *   node http-client.js "<URL>" out.pdf
 *   node http-client.js --url-from-file list.txt          # 批量（复用同一 Cookie）
 *   node http-client.js "<URL>" --check                  # 只测连通性，不落盘
 *
 * Cookie 优先级：
 *   --cookie-file <path>  >  环境变量 WAF_COOKIE  >  同目录 waf_cookie.txt
 *
 * 环境变量：
 *   WAF_COOKIE   直接内联 Cookie 字符串
 *   WAF_UA       自定义 User-Agent
 *   WAF_REFERER  自定义 Referer
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

// ───────────────────────── HTTP 层 ─────────────────────────

async function httpGet(url, { cookie, ua, referer } = {}) {
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/pdf,application/octet-stream,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive'
  };
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;

  const res = await fetch(url, { headers, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    ct: res.headers.get('content-type') || '',
    buf,
    setCookie: res.headers.getSetCookie ? res.headers.getSetCookie() : []
  };
}

function looksLikePdf(buf) {
  return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// ───────────────────────── Cookie 管理 ─────────────────────────

function loadCookie(explicitFile) {
  // 优先级：--cookie-file 参数 > WAF_COOKIE 环境变量 > WAF_COOKIE_FILE 环境变量
  //          > 同目录 waf_cookie.txt > 当前目录 waf_cookie.txt
  const candidates = [];
  if (explicitFile) candidates.push(explicitFile);
  if (process.env.WAF_COOKIE) return { value: process.env.WAF_COOKIE, from: '环境变量 WAF_COOKIE' };
  if (process.env.WAF_COOKIE_FILE) candidates.push(process.env.WAF_COOKIE_FILE);
  candidates.push(path.join(__dirname, 'waf_cookie.txt'));
  candidates.push(path.join(process.cwd(), 'waf_cookie.txt'));

  for (const f of candidates) {
    try {
      if (f && fs.existsSync(f)) {
        const v = fs.readFileSync(f, 'utf8').trim();
        if (v) return { value: v, from: f };
      }
    } catch (e) { /* 忽略 */ }
  }
  return { value: '', from: null };
}

/** 把新采集到的 Cookie 写回文件（若可写），供下次复用 */
function persistCookie(file, value) {
  if (!file) return;
  try {
    fs.writeFileSync(file, value);
  } catch (e) { /* 只读挂载等情况，忽略 */ }
}

const HINT =
`未找到有效 Cookie。

纯 HTTP 模式需要先补一次 Cookie（这一步需要浏览器执行挑战 JS，只需做一次）：

  node fetch-invoice.js --cookie-only "<任意该站点的URL>"

然后把输出的 Cookie 整行存到：
  ${path.join(__dirname, 'waf_cookie.txt')}

或直接设环境变量：
  WAF_COOKIE="<整行 Cookie>" node http-client.js "<URL>"
`;

// ───────────────────────── 单条下载 ─────────────────────────

async function download(url, outFile, cookie, opts) {
  const referer = opts.referer || new URL(url).origin + '/';
  const r = await httpGet(url, { cookie, ua: opts.ua, referer });

  if (r.status === 412 || r.status === 400) {
    throw new Error(
      `HTTP ${r.status} —— Cookie 无效或已过期。\n` +
      '重新执行：node fetch-invoice.js --cookie-only "<URL>"'
    );
  }
  if (r.status !== 200) throw new Error(`HTTP ${r.status} ${r.ct}`);

  if (!looksLikePdf(r.buf)) {
    const preview = r.buf.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ');
    throw new Error(`返回内容不是 PDF（${r.ct}，${r.buf.length} 字节）。开头: ${preview}`);
  }

  if (outFile) {
    fs.writeFileSync(outFile, r.buf);
    console.log(`  ✓ ${outFile}  ${r.buf.length} 字节`);
  }
  return { buf: r.buf, status: r.status, ct: r.ct };
}

// ───────────────────────── 自愈：412 时自动重取 Cookie ─────────────────────────

/**
 * 瑞数 Cookie 有效期实测只有 1~3 分钟（远短于最初估计的 15 分钟），
 * 且失效与 IP / 容器无关，纯粹是时间窗。
 * 因此这里实现「遇 412 自动重取并重试」，让调用方无需关心 Cookie 生命周期。
 *
 * 重取方式：调用同目录的 fetch-invoice.js --cookie-only（需要本机有浏览器）。
 * 若脚本不存在或执行失败，则退回到让调用方自行处理。
 */
async function refreshCookieViaBrowser(url) {
  const script = path.join(__dirname, 'fetch-invoice.js');
  if (!fs.existsSync(script)) {
    console.log('  ✗ 同目录下未找到 fetch-invoice.js，无法自动采集');
    return null;
  }

  const { execFile } = require('child_process');
  const cmd = process.execPath;
  const args = [script, '--cookie-only', url];

  console.log('  ↻ 收到 412，正在自动重新采集 Cookie ...');
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || '').trim().split('\n').slice(-1)[0] || err.message;
        console.log(`  ✗ 自动采集失败: ${detail}`);
        return resolve(null);
      }
      const m = stdout.match(/^Cookie:\s*(.+)$/m);
      if (!m) {
        console.log('  ✗ 自动采集失败: 未解析到 Cookie');
        return resolve(null);
      }
      console.log(`  ↻ 已获取新 Cookie (${m[1].trim().length} 字符)`);
      resolve(m[1].trim());
    });
  });
}

/**
 * 带自愈的下载：412 → 重取 Cookie → 重试（最多 maxRetry 次）
 */
async function downloadWithHeal(url, outFile, initialCookie, opts, maxRetry = 2) {
  let cookie = initialCookie;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    try {
      return await download(url, outFile, cookie, opts);
    } catch (e) {
      const isWaf = /HTTP (412|400)/.test(e.message);
      if (!isWaf || attempt === maxRetry) throw e;

      const fresh = await refreshCookieViaBrowser(url);
      if (!fresh) throw e;
      cookie = fresh;
      persistCookie(process.env.WAF_COOKIE_FILE, fresh);
    }
  }
  throw new Error('重试耗尽');
}

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const cookieFileIdx = argv.indexOf('--cookie-file');
  const cookieFile = cookieFileIdx >= 0 ? argv[cookieFileIdx + 1] : null;
  const checkOnly = argv.includes('--check');
  const listIdx = argv.indexOf('--url-from-file');
  const listFile = listIdx >= 0 ? argv[listIdx + 1] : null;
  const noHeal = argv.includes('--no-heal');

  const positional = argv.filter(a => !a.startsWith('--') && a !== cookieFile && a !== listFile);
  const ua = process.env.WAF_UA || DEFAULT_UA;
  const opts = { ua, referer: process.env.WAF_REFERER };

  let { value: cookie, from } = loadCookie(cookieFile);
  if (!cookie) { console.error(HINT); process.exit(2); }
  console.log(`[Cookie] ${from}  (${cookie.length} 字符)`);

  const doDownload = noHeal
    ? (u, o) => download(u, o, cookie, opts)
    : async (u, o) => {
        try {
          return await download(u, o, cookie, opts);
        } catch (e) {
          if (!/HTTP (412|400)/.test(e.message)) throw e;
          const fresh = await refreshCookieViaBrowser(u);
          if (!fresh) throw e;
          cookie = fresh;
          persistCookie(process.env.WAF_COOKIE_FILE, fresh);
          return download(u, o, cookie, opts);
        }
      };

  if (listFile) {
    if (!fs.existsSync(listFile)) throw new Error(`文件不存在: ${listFile}`);
    const urls = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    console.log(`批量模式：${urls.length} 条\n`);
    let ok = 0;
    for (let i = 0; i < urls.length; i++) {
      const out = `out_${String(i + 1).padStart(3, '0')}.pdf`;
      try {
        await doDownload(urls[i], checkOnly ? null : out);
        ok++;
      } catch (e) {
        console.log(`  ✗ [${i + 1}/${urls.length}] ${e.message.split('\n')[0]}`);
        break; // Cookie 过期，后面的必然失败，直接停
      }
    }
    console.log(`\n成功 ${ok}/${urls.length}`);
    if (ok < urls.length) console.log('提示：Cookie 已失效，重取后重跑。');
    return;
  }

  const url = positional[0];
  if (!url) {
    console.log('用法:');
    console.log('  node http-client.js "<URL>" [输出文件.pdf]');
    console.log('  node http-client.js --url-from-file list.txt');
    console.log('  node http-client.js "<URL>" --check');
    console.log('  node http-client.js "<URL>" --cookie-file mycookie.txt');
    console.log('  node http-client.js "<URL>" --no-heal      # 禁用 412 自动重取');
    console.log('\n环境变量: WAF_COOKIE / WAF_UA / WAF_REFERER');
    console.log('\n说明：默认开启自愈 —— 遇 412 自动调用 fetch-invoice.js 重取 Cookie 并重试。');
    process.exit(0);
  }

  const out = checkOnly ? null : (positional[1] || 'invoice.pdf');
  const r = await doDownload(url, out);
  if (!out) console.log(`  ✓ HTTP ${r.status} ${r.ct} ${r.buf.length} 字节`);
}

main().catch(e => { console.error('\n失败:', e.message); process.exit(1); });