/* ============================================================
 * 农田土壤墒情系统 — 本地服务（零依赖，Node 原生 http/https）
 * ------------------------------------------------------------
 * 职责：
 *   1) 静态托管 web/ 前端（同源，天然没有 CORS 问题）
 *   2) /api/ai/*  作为 AI 大模型代理：
 *        GET  /api/ai/config   前端查询后端是否已配置（只回模型名，绝不回密钥）
 *        POST /api/ai/test     连通性探针（max_tokens=4）
 *        POST /api/ai/chat     对话，支持 SSE 流式透传
 *
 * 为什么要有这一层：
 *   · API Key 只留在服务端进程里，浏览器/小程序拿不到，也不会被 F12 抄走；
 *   · 顺带解决浏览器直连大模型的 CORS 问题；
 *   · 客户端无法指定模型与密钥，避免被当成免费中转。
 *
 * 启动：node server/server.js        （可用 PORT / AI_API_KEY / AI_MODEL 覆盖配置）
 * ============================================================ */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ---------------- 配置 ---------------- */
let CFG;
try { CFG = require('./config.js'); }
catch (e) { CFG = require('./config.example.js'); }

const PORT = Number(process.env.PORT || CFG.port || 8080);
const WEB_ROOT = path.resolve(__dirname, CFG.webRoot || '../web');

const AI = {
  base:  String(process.env.AI_API_BASE || (CFG.ai && CFG.ai.base) || 'https://api.deepseek.com').replace(/\/+$/, ''),
  key:   String(process.env.AI_API_KEY  || (CFG.ai && CFG.ai.key)  || ''),
  model: String(process.env.AI_MODEL    || (CFG.ai && CFG.ai.model) || 'deepseek-chat'),
  temperature: Number((CFG.ai && CFG.ai.temperature) != null ? CFG.ai.temperature : 0.3),
  maxTokens:   Number((CFG.ai && CFG.ai.maxTokens)   != null ? CFG.ai.maxTokens   : 4096),
  timeoutMs:   Number((CFG.ai && CFG.ai.timeoutMs)   != null ? CFG.ai.timeoutMs   : 120000)
};
const MAX_CONCURRENT = Number(CFG.maxConcurrent || 4);
const PER_IP_PER_MIN = Number(CFG.perIpPerMinute || 0);

function upstreamUrl() {
  if (/\/chat\/completions$/i.test(AI.base)) return AI.base;
  return AI.base + '/chat/completions';
}

function maskKey(k) {
  if (!k) return '';
  const s = String(k);
  if (s.length <= 12) return '****';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

function log(tag, msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log('[' + t + '] ' + tag + ' ' + msg);
}

/* ---------------- 限流 ---------------- */
let inflight = 0;
const hits = new Map();   // ip -> [ts, ts, ...]
function rateOk(ip) {
  if (!PER_IP_PER_MIN) return true;
  const now = Date.now();
  let arr = hits.get(ip) || [];
  arr = arr.filter(t => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length <= PER_IP_PER_MIN;
}

/* ---------------- HTTP 小工具 ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req, limit) {
  limit = limit || 1024 * 1024;   // 1MB 足够（数据上下文已在前台抽稀）
  return new Promise((resolve, reject) => {
    let buf = '';
    let aborted = false;
    req.on('data', c => {
      buf += c;
      if (buf.length > limit) { aborted = true; reject(new Error('请求体过大（上限 1MB）')); req.destroy(); }
    });
    req.on('end', () => { if (!aborted) resolve(buf); });
    req.on('error', reject);
  });
}
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

/* ---------------- 转发到上游 ---------------- */
/* 返回 Promise：
 *   stream=true  →  resolve({ stream: upstreamRes })
 *   stream=false →  resolve({ json: parsedObject, status, raw })
 * 出错 reject(Error)，err.status / err.body 带上上游信息 */
function callUpstream(payload, stream) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(upstreamUrl()); }
    catch (e) { return reject(new Error('AI 接口地址不合法：' + AI.base)); }

    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + AI.key,
        'Accept': stream ? 'text/event-stream' : 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: AI.timeoutMs
    }, res => {
      if (stream) {
        if (res.statusCode >= 400) {
          // 流式请求出错时上游返回的是 JSON，不是 SSE，读出来翻译成人话
          let txt = '';
          res.on('data', c => { txt += c; });
          res.on('end', () => {
            const e = new Error(errText(res.statusCode, txt));
            e.status = res.statusCode; e.body = txt;
            reject(e);
          });
          return;
        }
        resolve({ stream: res, status: res.statusCode });
        return;
      }
      let txt = '';
      res.on('data', c => { txt += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          const e = new Error(errText(res.statusCode, txt));
          e.status = res.statusCode; e.body = txt;
          return reject(e);
        }
        let j = null;
        try { j = JSON.parse(txt); } catch (e) { j = null; }
        resolve({ json: j, status: res.statusCode, raw: txt });
      });
    });

    req.on('timeout', () => { req.destroy(new Error('上游超时（' + AI.timeoutMs + ' ms 无响应）')); });
    req.on('error', e => reject(e));
    req.write(body);
    req.end();
  });
}

/* 上游错误码 → 人话（前端设置页直接展示这段文本） */
function errText(status, body) {
  let m = '';
  try {
    const j = JSON.parse(body);
    m = (j && ((j.error && (j.error.message || j.error.code)) || j.message || j.msg)) || '';
  } catch (e) { m = String(body || '').slice(0, 200); }
  m = String(m || '').trim();
  let head;
  if (status === 401) head = '401 鉴权失败：API Key 无效或已过期（请检查 server/config.js）';
  else if (status === 402) head = '402 余额不足：请到服务商控制台充值';
  else if (status === 403) head = '403 拒绝访问：账号无该模型权限';
  else if (status === 404) head = '404 接口地址或模型名不存在（检查 base 与 model）';
  else if (status === 422) head = '422 请求参数被拒绝：模型可能不支持该参数';
  else if (status === 429) head = '429 触发限流或配额耗尽，请稍后再试';
  else if (status >= 500) head = status + ' 上游服务端错误，请稍后重试';
  else if (status) head = status + ' 请求失败';
  else head = '上游请求失败';
  return head + (m ? '｜' + m.slice(0, 200) : '');
}

/* 只放行这几个字段，模型与密钥一律由服务端决定，客户端改不了 */
function sanitizePayload(input, stream) {
  const messages = Array.isArray(input && input.messages) ? input.messages : null;
  if (!messages || !messages.length) return null;
  let temp = Number(input && input.temperature);
  if (!isFinite(temp)) temp = AI.temperature;
  temp = Math.min(1, Math.max(0, temp));
  let maxTokens = Number(input && input.max_tokens);
  if (!isFinite(maxTokens) || maxTokens <= 0) maxTokens = AI.maxTokens;
  // 推理型模型会先用掉几百个思维链 token，上限给到 8192，避免正文被截断
  maxTokens = Math.min(8192, Math.round(maxTokens));
  return {
    model: AI.model,
    messages: messages.map(m => ({
      role: (m && (m.role === 'assistant' || m.role === 'system')) ? m.role : 'user',
      content: String((m && m.content) != null ? m.content : '').slice(0, 32000)
    })),
    temperature: temp,
    max_tokens: maxTokens,
    stream: !!stream
  };
}

/* ---------------- API ---------------- */
function apiConfig(req, res) {
  sendJson(res, 200, {
    ok: true,
    configured: !!AI.key,
    provider: AI.base.replace(/^https?:\/\//, ''),
    model: AI.model,
    temperature: AI.temperature,
    maxTokens: AI.maxTokens,
    keyHint: maskKey(AI.key),
    /* 前端用不到，只用于设置页展示："密钥托管在服务端" */
    mode: 'server-proxy'
  });
}

function apiTest(req, res) {
  readBody(req).then(raw => {
    let input = {};
    try { input = raw ? JSON.parse(raw) : {}; } catch (e) { input = {}; }
    if (!AI.key) return sendJson(res, 200, { ok: false, msg: '服务端尚未配置 API Key（编辑 server/config.js 或设置环境变量 AI_API_KEY）' });

    const t0 = Date.now();
    const payload = {
      model: AI.model,
      messages: [
        { role: 'system', content: 'You are a connectivity probe. Answer with one short word, do not explain.' },
        { role: 'user', content: 'Reply: OK' }
      ],
      // 推理型模型会先用掉一批思维链 token，给到 32 才能让正文真的吐出来
      max_tokens: 32,
      temperature: 0,
      stream: false
    };
    return callUpstream(payload, false).then(r => {
      const j = r.json || {};
      const reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      sendJson(res, 200, {
        ok: true,
        msg: '接口可用',
        model: j.model || AI.model,
        latency: Date.now() - t0,
        reply: String(reply).slice(0, 40)
      });
    }).catch(e => {
      log('AI-TEST', '失败：' + e.message);
      sendJson(res, 200, { ok: false, msg: e.message || String(e), latency: Date.now() - t0 });
    });
  }).catch(e => sendJson(res, 400, { ok: false, msg: e.message || '请求体读取失败' }));
}

function apiChat(req, res) {
  readBody(req).then(raw => {
    let input;
    try { input = JSON.parse(raw || '{}'); }
    catch (e) { return sendJson(res, 400, { ok: false, msg: '请求体不是合法 JSON' }); }
    if (!AI.key) return sendJson(res, 200, { ok: false, msg: '服务端尚未配置 API Key（编辑 server/config.js）' });

    const stream = input.stream !== false;
    const payload = sanitizePayload(input, stream);
    if (!payload) return sendJson(res, 400, { ok: false, msg: 'messages 为空或格式不正确' });

    if (inflight >= MAX_CONCURRENT) {
      return sendJson(res, 429, { ok: false, msg: '当前并发已满（最多 ' + MAX_CONCURRENT + ' 个），请稍后再试' });
    }
    inflight++;
    const done = () => { inflight--; };
    log('AI-CHAT', 'model=' + AI.model + ' msgs=' + payload.messages.length + ' stream=' + stream);

    callUpstream(payload, stream).then(r => {
      if (!stream) {
        done();
        const j = r.json || {};
        const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        return sendJson(res, 200, { ok: true, text: String(text), model: j.model || AI.model });
      }
      /* ---- SSE 透传：上游给什么就原样转什么，不在中间做解析 ---- */
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      const up = r.stream;
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true; done();
        try { res.end(); } catch (e) {}
      };
      up.on('data', c => { if (!closed) res.write(c); });
      up.on('end', finish);
      up.on('error', () => {
        if (!closed) { res.write('data: ' + JSON.stringify({ error: { message: '上游连接中断' } }) + '\n\n'); }
        finish();
      });
      // 浏览器端「停止」→ 前端 abort → 这条连接关闭 → 把上游也掐掉，别浪费 token
      res.on('close', () => {
        if (closed) return;
        closed = true; done();
        try { up.destroy(); } catch (e) {}
      });
    }).catch(e => {
      done();
      log('AI-CHAT', '失败：' + e.message);
      if (!res.headersSent) return sendJson(res, 200, { ok: false, msg: e.message || String(e) });
      try { res.write('data: ' + JSON.stringify({ error: { message: e.message || '上游失败' } }) + '\n\n'); res.end(); } catch (er) {}
    });
  }).catch(e => sendJson(res, 400, { ok: false, msg: e.message || '请求体读取失败' }));
}

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(WEB_ROOT, rel);
  // 防目录穿越：解析后必须仍在 WEB_ROOT 内
  if (abs.indexOf(WEB_ROOT) !== 0) { res.writeHead(403); return res.end('403 Forbidden'); }
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + rel);
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      // 带 ?v= 的静态资源照常缓存；html 不做缓存，改完刷新即可见
      'Cache-Control': /\.html?$/i.test(abs) ? 'no-cache' : 'public, max-age=600'
    });
    fs.createReadStream(abs)
      .on('error', () => { try { res.end(); } catch (e) {} })
      .pipe(res);
  });
}

/* ---------------- 主服务 ---------------- */
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://' + (req.headers.host || 'localhost')).pathname; }
  catch (e) { pathname = req.url.split('?')[0]; }

  // 允许跨域（前后端分离部署时用得上）；同源访问不受影响
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname.indexOf('/api/ai/') === 0) {
    if (!rateOk(clientIp(req))) return sendJson(res, 429, { ok: false, msg: '请求过于频繁，请稍后再试' });
    if (pathname === '/api/ai/config' && req.method === 'GET') return apiConfig(req, res);
    if (pathname === '/api/ai/test'   && req.method === 'POST') return apiTest(req, res);
    if (pathname === '/api/ai/chat'   && req.method === 'POST') return apiChat(req, res);
    return sendJson(res, 404, { ok: false, msg: '未知接口：' + pathname });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('405 Method Not Allowed');
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  农田土壤墒情系统 · 本地服务已启动');
  console.log('  ────────────────────────────────────────────');
  console.log('  前端地址   http://localhost:' + PORT + '/');
  console.log('  AI 代理    http://localhost:' + PORT + '/api/ai/chat');
  console.log('  上游       ' + upstreamUrl());
  console.log('  模型       ' + AI.model);
  console.log('  密钥       ' + (AI.key ? maskKey(AI.key) + '（服务端保存，不下发前端）' : '未配置 ⚠️'));
  console.log('  静态目录   ' + WEB_ROOT);
  console.log('  ────────────────────────────────────────────');
  console.log('');
});

server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') console.error('端口 ' + PORT + ' 已被占用，请改 PORT 环境变量或 server/config.js 里的 port。');
  else console.error(e);
  process.exit(1);
});

process.on('SIGINT', () => { console.log('\n已停止。'); process.exit(0); });
