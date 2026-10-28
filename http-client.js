#!/usr/bin/env node
/**
 * 瑞数 WAF —— 纯 HTTP 重放下载器（零浏览器依赖，零 npm 依赖）
 *
 * 核心思路：WAF 挑战只在「取 Cookie」那一步需要 JS 执行环境；
 * 一旦拿到有效 Cookie，后续请求全部是普通 HTTP。
 * 因此把流程拆成两段：
 *   1. 取 Cookie —— 在有浏览器的环境跑一次 `waf-token.js --cookie-only`
 *   2. 纯 HTTP 下载 —— 本脚本，全程 fetch 语义，不启动任何浏览器
 *
 * 适合：服务端 / 定时任务 / 容器 / CI —— 只要 Cookie 还没过期。
 *
 * 用法：
 *   node http-client.js "<URL>"                          # 下载到 invoice.pdf
 *   node http-client.js "<URL>" out.pdf
 *   node http-client.js "<URL>" --check                  # 只测连通性，不落盘
 *   node http-client.js --url-from-file list.txt          # 批量（复用同一 Cookie）
 *
 * 环境变量：
 *   WAF_COOKIE       直接内联 Cookie 字符串
 *   WAF_COOKIE_FILE  Cookie 文件路径
 *   WAF_UA           自定义 User-Agent
 *   WAF_REFERER      自定义 Referer
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

// ───────────────────────── HTTP 层 ─────────────────────────

async function httpGet(url, { cookie, ua, referer }) {
  const headers = {
    'User-Agent': ua,
    'Accept': 'application/pdf,application/octet-stream,*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (cookie) headers['Cookie'] = cookie;
  if (referer) headers['Referer'] = referer;

  const res = await fetch(url, { headers, redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    ct: res.headers.get('content-type') || '',
    buf,
  };
}

function looksLikePdf(buf) {
  return buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

// ───────────────────────── Cookie 管理 ─────────────────────────

function loadCookie(explicitFile) {
  const candidates = [];
  if (explicitFile) candidates.push(explicitFile);
  if (process.env.WAF_COOKIE) {
    return { value: process.env.WAF_COOKIE, from: '环境变量 WAF_COOKIE' };
  }
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

const HINT = `未找到有效 Cookie。

纯 HTTP 模式需要先补一次 Cookie（这一步需要浏览器执行挑战 JS，只需做一次）：

  node waf-token.js "<任意该站点的URL>" --json

然后把输出的 cookie 字段存到：
  ${path.join(__dirname, 'waf_cookie.txt')}

或直接设环境变量：
  WAF_COOKIE="<整行 Cookie>" node http-client.js "<URL>"
`;

// ───────────────────────── 下载 ─────────────────────────

async function download(url, outFile, cookie, opts) {
  const referer = opts.referer || new URL(url).origin + '/';
  const r = await httpGet(url, { cookie, ua: opts.ua, referer });

  if (r.status === 412 || r.status === 400) {
    throw new Error(
      `HTTP ${r.status} —— Cookie 无效或已过期。\n` +
      '重新执行：node waf-token.js "<URL>" --json'
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

// ───────────────────────── CLI ─────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const cookieFileIdx = argv.indexOf('--cookie-file');
  const cookieFile = cookieFileIdx >= 0 ? argv[cookieFileIdx + 1] : null;
  const checkOnly = argv.includes('--check');
  const listIdx = argv.indexOf('--url-from-file');
  const listFile = listIdx >= 0 ? argv[listIdx + 1] : null;

  const positional = argv.filter(a => !a.startsWith('--') && a !== cookieFile && a !== listFile);
  const ua = process.env.WAF_UA || DEFAULT_UA;
  const opts = { ua, referer: process.env.WAF_REFERER };

  const { value: cookie, from } = loadCookie(cookieFile);
  if (!cookie) { console.error(HINT); process.exit(2); }
  console.log(`[Cookie] ${from}  (${cookie.length} 字符)`);

  const url = positional[0];
  if (!url) {
    console.log('用法:');
    console.log('  node http-client.js "<URL>" [输出文件.pdf]');
    console.log('  node http-client.js "<URL>" --check');
    console.log('  node http-client.js --url-from-file list.txt');
    console.log('  node http-client.js "<URL>" --cookie-file mycookie.txt');
    console.log('\n环境变量: WAF_COOKIE / WAF_COOKIE_FILE / WAF_UA / WAF_REFERER');
    process.exit(0);
  }

  if (listFile) {
    if (!fs.existsSync(listFile)) throw new Error(`文件不存在: ${listFile}`);
    const urls = fs.readFileSync(listFile, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    console.log(`批量模式：${urls.length} 条\n`);
    let ok = 0;
    for (let i = 0; i < urls.length; i++) {
      const out = `out_${String(i + 1).padStart(3, '0')}.pdf`;
      try {
        await download(urls[i], checkOnly ? null : out, cookie, opts);
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

  const out = checkOnly ? null : (positional[1] || 'invoice.pdf');
  const r = await download(url, out, cookie, opts);
  if (!out) console.log(`  ✓ HTTP ${r.status} ${r.ct} ${r.buf.length} 字节`);
}

main().catch(e => { console.error('\n失败:', e.message); process.exit(1); });
