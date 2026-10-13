/* ============================================================
 * AI 分析助手（网页版）— 后端代理模式
 * ------------------------------------------------------------
 * 依赖：无（原生 fetch + TextDecoder）
 * 暴露：window.AIAgent
 *
 * 设计要点：
 *  1) 浏览器不再接触任何 API Key。密钥只写在 server/config.js，
 *     由 server/server.js 代为调用上游大模型，前端只跟同源的 /api/ai/* 打交道。
 *  2) 前端只保留两项本地配置：后端地址（默认同源 api/ai）和温度；
 *     模型与密钥由服务端决定，客户端改不了，不会被当成免费中转。
 *  3) 提问时自动把「最新读数 + 阈值 + 当前分析时段统计」拼成上下文一起发送，
 *     这样 AI 才能做真正的数据分析，而不是空对空聊天。
 * ============================================================ */
(function (global) {
  'use strict';

  var K = { base: 'ai_api_base', temp: 'ai_temp' };

  var DEFAULTS = {
    base: 'api/ai',      // 同源后端；前后端分离部署时可填 http://host:8080/api/ai
    temp: 0.3
  };

  /* 旧版本曾把 API Key 存在浏览器 localStorage 里。改成后端代理后这些都没用了，
   * 首次加载一律清掉，避免密钥继续留在本机浏览器里。 */
  (function purgeLegacyKeys() {
    try {
      localStorage.removeItem('ai_key');
      localStorage.removeItem('ai_base');
      localStorage.removeItem('ai_model');
      localStorage.removeItem('ai_sys');
    } catch (e) { /* 隐私模式下 localStorage 不可用，忽略 */ }
  })();

  /* ---------------- 配置读写 ---------------- */
  function ls(k, d) {
    try { var v = localStorage.getItem(k); return (v === null || v === undefined) ? d : v; }
    catch (e) { return d; }
  }
  function lset(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function getCfg() {
    var rawTemp = ls(K.temp, '');
    // 未保存过（''）时不能当成 0 用，否则默认温度会变成 0（回答过于死板）
    var temp = (rawTemp === '' || rawTemp === null) ? NaN : Number(rawTemp);
    return {
      base: (String(ls(K.base, '') || '').trim() || DEFAULTS.base),
      temp: isFinite(temp) ? Math.min(1, Math.max(0, temp)) : DEFAULTS.temp
    };
  }
  function saveCfg(c) {
    lset(K.base, String(c.base || '').trim() || DEFAULTS.base);
    lset(K.temp, String(c.temp));
  }

  /* ---------------- 后端状态 ---------------- */
  /* 后端会回 { ok, configured, model, provider, keyHint, ... }，
   * 其中绝不包含密钥原文，前端只拿它来判断"能不能用"。 */
  var SRV = { cfg: null, err: '', loading: null, ts: 0 };

  function api(path) {
    var b = String(getCfg().base || DEFAULTS.base).replace(/\/+$/, '');
    return b + '/' + path;
  }

  /* 后端没起来 / 地址填错时的统一话术 */
  function backendDownHint() {
    return '连不上 AI 后端（' + api('config') + '）。' +
      '请在项目根目录执行 node server/server.js 启动后端；' +
      '若前后端分开部署，请到「⚙️ 系统设置 → 🤖 AI 助手」填写正确的后端地址。';
  }

  function fetchServerCfg(force) {
    if (SRV.loading) return SRV.loading;
    if (!force && SRV.cfg && (Date.now() - SRV.ts) < 60000) return Promise.resolve(SRV.cfg);
    SRV.loading = fetch(api('config'), { method: 'GET', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        SRV.loading = null; SRV.ts = Date.now();
        if (j && j.ok) { SRV.cfg = j; SRV.err = ''; }
        else { SRV.cfg = null; SRV.err = (j && j.msg) || '后端返回异常'; }
        return SRV.cfg;
      })
      .catch(function () {
        SRV.loading = null; SRV.ts = Date.now();
        SRV.cfg = null; SRV.err = backendDownHint();
        return null;
      });
    return SRV.loading;
  }

  function cfgReady() {
    var c = getCfg();
    if (!c.base) return false;
    return !!(SRV.cfg && SRV.cfg.configured);
  }
  function modelName() { return (SRV.cfg && SRV.cfg.model) || ''; }

  /* 兼容旧调用：返回后端 chat 地址 */
  function endpoint() { return api('chat'); }

  /* ---------------- 错误翻译 ---------------- */
  /* 后端已经把上游错误码翻成人话，这里只做兜底 */
  function errText(status, body) {
    var m = '';
    try {
      var j = typeof body === 'string' ? JSON.parse(body) : body;
      m = (j && (j.msg || (j.error && (j.error.message || j.error.code)) || j.message)) || '';
    } catch (e) { m = String(body || '').slice(0, 160); }
    m = String(m || '').trim();
    var head = '';
    if (status === 401) head = '401 未授权';
    else if (status === 404) head = '404 后端接口不存在（后端地址可能填错）';
    else if (status === 429) head = '429 请求过于频繁或并发已满，请稍后再试';
    else if (status >= 500) head = status + ' 后端错误';
    else if (status) head = status + ' 请求失败';
    else head = '请求失败';
    return head + (m ? '｜' + m.slice(0, 160) : '');
  }

  /* ---------------- 请求 ---------------- */
  function postJson(path, payload, ctl) {
    return fetch(api(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctl ? ctl.signal : undefined
    });
  }

  /* 连通性检测：让后端用极小 max_tokens 打一针，验证「后端 + 密钥 + 模型」整条链路 */
  function testConnection() {
    var t0 = Date.now();
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 25000) : null;
    return postJson('test', {}, ctl).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          return { ok: false, msg: errText(res.status, t), latency: Date.now() - t0 };
        });
      }
      return res.json().then(function (j) {
        if (j && j.ok) {
          SRV.cfg = SRV.cfg || {};
          if (j.model) SRV.cfg.model = j.model;
          return {
            ok: true,
            msg: '接口可用',
            model: j.model || modelName() || '--',
            latency: (j.latency != null ? j.latency : Date.now() - t0),
            reply: j.reply || '',
            provider: j.provider || (SRV.cfg && SRV.cfg.provider) || ''
          };
        }
        return { ok: false, msg: (j && j.msg) || '检测失败', latency: Date.now() - t0 };
      });
    }).catch(function (e) {
      var msg = (e && e.name === 'AbortError') ? '检测超时（25 秒无响应）' : backendDownHint();
      return { ok: false, msg: msg, latency: Date.now() - t0 };
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    });
  }

  /* 后端已固定模型，不再需要前端拉取模型列表；保留空实现以免旧调用报错 */
  function listModels() { return Promise.resolve(null); }

  /* ---------------- 对话 ---------------- */
  /* onDelta(chunkText) 逐字回调；返回 Promise<{ok, text, msg}> */
  function chat(messages, opt) {
    opt = opt || {};
    var cfg = getCfg();
    if (!cfgReady()) {
      return Promise.resolve({ ok: false, msg: SRV.err || backendDownHint() });
    }

    var payload = {
      messages: messages,
      temperature: cfg.temp,
      stream: !!opt.stream
    };
    if (opt.maxTokens) payload.max_tokens = opt.maxTokens;

    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (ctl) opt._controller = ctl;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, opt.timeout || 150000) : null;

    var init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl ? ctl.signal : undefined
    };

    return fetch(api('chat'), init).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          return { ok: false, msg: errText(res.status, t) };
        });
      }
      if (!opt.stream) {
        return res.text().then(function (t) {
          try {
            var j = JSON.parse(t);
            var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
            return { ok: true, text: String(c || '').trim() };
          } catch (e) {
            return { ok: false, msg: '返回内容解析失败：' + t.slice(0, 160) };
          }
        });
      }
      /* ---- SSE 流式解析 ---- */
      var reader = res.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '', full = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return { ok: true, text: full };
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          for (var i = 0; i < lines.length; i++) {
            var s = lines[i].trim();
            if (s.indexOf('data:') !== 0) continue;
            var d = s.slice(5).trim();
            if (d === '[DONE]') return { ok: true, text: full };
            try {
              var j = JSON.parse(d);
              var ch = j.choices && j.choices[0];
              var dl = (ch && ch.delta) || {};
              var delta = dl.content || (ch && ch.text) || '';
              // 推理型模型（如 deepseek-flash）会先吐一大段 reasoning_content，正文要等它想完
              var reason = dl.reasoning_content || '';
              if (delta) { full += delta; if (opt.onDelta) opt.onDelta(delta); }
              else if (reason && opt.onReason) opt.onReason(reason);
            } catch (e) { /* 忽略 keep-alive / 心跳行 */ }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') {
        return { ok: false, msg: '请求超时或已中断', text: '' };
      }
      return { ok: false, msg: backendDownHint() + (e && e.message ? '（' + e.message + '）' : '') };
    }).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    });
  }

  /* ---------------- 提示词 ---------------- */
  var SYSTEM = [
    '你是「农田土壤墒情云端采集与数据分析系统」内置的 AI 助手，同时扮演三种角色：',
    '1）农业数据分析师：能读懂传感器时序数据、统计指标、相关性、ARIMA 预测，并给出有依据的解读；',
    '2）农艺顾问：熟悉番茄等作物的需水规律、灌溉时机、土壤温湿度与病害风险；',
    '3）本系统的答疑客服：熟悉 ESP32 + 巴法云 MQTT 的接入方式、阈值下发、远程灌溉/报警、数据导出等操作。',
    '',
    '回答要求：',
    '· 使用简体中文，条理清晰，优先给结论，再给依据，最后给可执行建议；',
    '· 涉及数字时必须引用上下文中给出的真实数据，禁止凭空编造传感器读数；',
    '· 上下文里没有的数据，直接说明"当前数据不足"，不要假设；',
    '· 给出灌溉/施肥/打药等建议时，必须提示结合田间实际情况复核；',
    '· 适当使用短列表和加粗，不要输出大段无换行文字；',
    '· 不确定的技术细节要说明不确定，不要装作确定。'
  ].join('\n');

  var QUICK = [
    { icon: '📊', title: '一键分析当前数据', q: '请根据我提供的当前数据与统计指标，做一份简明的墒情分析：整体水平如何、是否存在异常波动、需要关注哪些指标。' },
    { icon: '💧', title: '灌溉决策建议', q: '结合当前土壤湿度、趋势预测和近期变化速率，我现在应不应该灌溉？如果要，建议什么时间、大概多久，为什么？' },
    { icon: '📈', title: '趋势解读与预测', q: '请解读时序趋势与 ARIMA 预测结果：未来几小时土壤湿度会怎么走，什么时候可能跌破阈值下限？' },
    { icon: '⚠️', title: '异常诊断排查', q: '请检查这些数据是否存在异常：传感器漂移、数据长时间不更新、数值超出物理量程、指标之间关系反常等，并给出排查步骤。' },
    { icon: '🌿', title: '番茄种植咨询', q: '按番茄的生长需求，当前土壤温湿度和空气温湿度是否合适？接下来 24 小时田间管理要注意什么？' },
    { icon: '🔧', title: '设备与系统答疑', q: '请介绍这套系统的工作方式：ESP32 怎么上报数据、阈值怎么下发、远程灌溉和报警怎么用、数据多久存一次。' },
    { icon: '🧪', title: '传感器原理答疑', q: '请解释 HW-390 土壤湿度、DS18B20 土壤温度、DHT11 空气温湿度各自的原理、精度、安装注意事项和常见误差来源。' },
    { icon: '📋', title: '生成分析报告', q: '请把以上数据整理成一份可以直接贴进课程设计/毕业论文的墒情分析报告，含数据概况、统计特征、相关性、结论与建议。' }
  ];

  /* ---------------- 数据上下文 ---------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ts(ms) {
    if (!ms) return '--';
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function hm(ms) {
    if (!ms) return '--';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function n1(v, d) { var x = Number(v); return isFinite(x) ? x.toFixed(d === undefined ? 1 : d) : '--'; }

  function levelName(sh, thr) {
    var lo = Number(thr && thr.shLow), op = Number(thr && thr.shOpt);
    if (!isFinite(lo)) lo = 45;
    if (!isFinite(op)) op = 65;
    var hi = Math.min(100, Math.max(op + 1, Math.round(op + (op - lo))));
    if (!isFinite(Number(sh))) return '--';
    if (sh < 30) return '重旱';
    if (sh < lo) return '轻旱';
    if (sh < op) return '适宜';
    if (sh < hi) return '过湿';
    return '积水';
  }

  /* ctx = { latest:{sh,st,ah,at}, rssi, lastUpdate, topic, thr:{}, an:{...}, records:[], route } */
  function buildContext(ctx) {
    ctx = ctx || {};
    var L = [];
    var thr = ctx.thr || {};
    var latest = ctx.latest || null;
    var an = ctx.an || {};

    L.push('=== 农田土壤墒情系统 · 实时数据上下文 ===');
    L.push('系统时间：' + ts(Date.now()));
    L.push('设备主题：' + (ctx.topic || '--') + '　数据源：ESP32 + 巴法云 MQTT（上报周期约 30 秒）');

    if (latest) {
      L.push('');
      L.push('【最新一次读数】' + (ctx.lastUpdate ? '（上报时间 ' + ctx.lastUpdate + '）' : ''));
      L.push('· 土壤湿度：' + n1(latest.sh) + ' %　等级判定：' + levelName(latest.sh, thr));
      L.push('· 土壤温度：' + n1(latest.st) + ' ℃（DS18B20）');
      L.push('· 空气湿度：' + n1(latest.ah, 0) + ' %（DHT11）');
      L.push('· 空气温度：' + n1(latest.at) + ' ℃（DHT11）');
      if (ctx.rssi !== undefined && ctx.rssi !== null) L.push('· WiFi 信号强度：' + ctx.rssi + ' dBm');
    } else {
      L.push('');
      L.push('【最新一次读数】暂无（设备离线或尚未上报）');
    }

    L.push('');
    L.push('【当前告警阈值】');
    L.push('· 土壤湿度：轻旱线 ' + n1(thr.shLow, 0) + ' %，适宜上界 ' + n1(thr.shOpt, 0) + ' %，积水线 ' +
      Math.min(100, Math.max(Number(thr.shOpt) + 1 || 66, Math.round((Number(thr.shOpt) || 65) + ((Number(thr.shOpt) || 65) - (Number(thr.shLow) || 45))))) + ' %');
    L.push('· 土壤温度：' + n1(thr.stLow, 0) + ' ~ ' + n1(thr.stHi, 0) + ' ℃');
    L.push('· 空气湿度：' + n1(thr.ahLow, 0) + ' ~ ' + n1(thr.ahHi, 0) + ' %');
    L.push('· 空气温度：' + n1(thr.atLow, 0) + ' ~ ' + n1(thr.atHi, 0) + ' ℃');

    var recs = ctx.records || [];
    if (recs.length) {
      L.push('');
      L.push('【当前分析时段】' + (an.startDate ? an.startDate + ' ' + (an.startTime || '00:00') : '--') +
        ' ~ ' + (an.endDate ? an.endDate + ' ' + (an.endTime || '23:59') : '--') +
        '　数据源：' + (an.fetchMode === 'bemfa' ? '巴法云实时（30 秒自动刷新）' : '云端数据库'));
      L.push('· 样本量：' + recs.length + ' 条　时间跨度：' + (an.spanText || '--') + '　平均采样间隔：' + (an.intervalText || '--'));

      ['sh', 'st', 'ah', 'at'].forEach(function (k) {
        var name = { sh: '土壤湿度(%)', st: '土壤温度(℃)', ah: '空气湿度(%)', at: '空气温度(℃)' }[k];
        var v = [];
        recs.forEach(function (r) { if (r && isFinite(Number(r[k]))) v.push(Number(r[k])); });
        if (!v.length) return;
        var sorted = v.slice().sort(function (a, b) { return a - b; });
        var n = sorted.length, sum = 0;
        sorted.forEach(function (x) { sum += x; });
        var avg = sum / n;
        var med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        var vs = 0; sorted.forEach(function (x) { vs += (x - avg) * (x - avg); });
        var std = Math.sqrt(vs / n);
        L.push('· ' + name + '：min ' + n1(sorted[0]) + ' / max ' + n1(sorted[n - 1]) +
          ' / 均值 ' + n1(avg) + ' / 中位数 ' + n1(med) + ' / 标准差 ' + n1(std) +
          ' / 变异系数 ' + n1(avg ? std / Math.abs(avg) * 100 : 0, 1) + '%');
      });

      var f = an.forecast || {};
      if (f && f.arimaEnough) {
        L.push('· ARIMA(0,1,1) 单步预测下一时刻土壤湿度：' + f.arimaNext + ' %（区间 ' + f.arimaLo + ' ~ ' + f.arimaHi + ' %，RMSE ' + f.arimaRmse + '）');
      }
      var c = an.corr || {};
      if (c && Object.keys(c).length) {
        L.push('· 相关性（Pearson）：气温↔土湿 ' + c.at_sh + '，气湿↔土湿 ' + c.ah_sh + '，土温↔土湿 ' + c.st_sh + '，气温↔气湿 ' + c.at_ah);
      }
      if (an.topLevel) L.push('· 墒情等级占比最高：' + an.topLevel + '（' + an.topPct + '%）');

      // 原始采样：等距抽稀，最多 40 行，避免 token 爆炸
      var step = Math.max(1, Math.ceil(recs.length / 40));
      var rows = [];
      for (var i = 0; i < recs.length; i += step) rows.push(recs[i]);
      if (rows.length && rows[rows.length - 1] !== recs[recs.length - 1]) rows.push(recs[recs.length - 1]);
      L.push('');
      L.push('【时段内采样（等距抽取 ' + rows.length + '/' + recs.length + ' 条）】');
      L.push('时间,土壤湿度%,土壤温度℃,空气湿度%,空气温度℃');
      rows.forEach(function (r) {
        if (!r) return;
        L.push(hm(r.unix) + ',' + n1(r.sh) + ',' + n1(r.st) + ',' + n1(r.ah, 0) + ',' + n1(r.at));
      });
    } else {
      L.push('');
      L.push('【当前分析时段】暂无数据（可先到「数据分析」页选择一个有时段的区间再回来提问）');
    }

    L.push('');
    L.push('（以上为系统自动附加的真实数据，请基于这些数据分析作答，不要编造未给出的数值。）');
    return L.join('\n');
  }

  /* ============================================================
   * UI 层
   * ============================================================ */
  var UI = {
    getContext: null,       // 由 app.js 注入：() => ctx
    jumpSettings: null,     // 由 app.js 注入
    history: [],            // [{role, content}]
    sending: false,
    ctrl: null,             // 当前请求的 AbortController
    aborted: false          // 用户是否点了「停止」
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* 极简 Markdown：加粗 / 行内代码 / 标题 / 列表 / 表格降级为文本块 */
  function md(s) {
    var t = esc(s);
    t = t.replace(/```([\s\S]*?)```/g, function (m, code) {
      return '<pre class="ai-code">' + code.replace(/^\n/, '') + '</pre>';
    });
    t = t.replace(/`([^`\n]+)`/g, '<code class="ai-code-inline">$1</code>');
    t = t.replace(/^######\s*(.*)$/gm, '<div class="ai-h6">$1</div>');
    t = t.replace(/^#####\s*(.*)$/gm, '<div class="ai-h5">$1</div>');
    t = t.replace(/^####\s*(.*)$/gm, '<div class="ai-h4">$1</div>');
    t = t.replace(/^###\s*(.*)$/gm, '<div class="ai-h3">$1</div>');
    t = t.replace(/^##\s*(.*)$/gm, '<div class="ai-h2">$1</div>');
    t = t.replace(/^#\s*(.*)$/gm, '<div class="ai-h1">$1</div>');
    t = t.replace(/^\s*([-*+])\s+(.*)$/gm, '<div class="ai-li">• $2</div>');
    t = t.replace(/^\s*(\d+)[.)]\s+(.*)$/gm, '<div class="ai-li">$1. $2</div>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/\n/g, '<br/>');
    t = t.replace(/(<br\/>)+<div/g, '<div');
    return t;
  }

  function scrollBottom() {
    var box = $('ai-chat-list');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function pushBubble(role, html, id) {
    var box = $('ai-chat-list');
    if (!box) return null;
    var d = document.createElement('div');
    d.className = 'ai-msg ai-msg-' + role;
    if (id) d.id = id;
    d.innerHTML =
      '<div class="ai-avatar">' + (role === 'user' ? '🙋' : (role === 'sys' ? 'ℹ️' : '🤖')) + '</div>' +
      '<div class="ai-bubble">' + html + '</div>';
    box.appendChild(d);
    scrollBottom();
    return d;
  }

  function renderWelcome() {
    var box = $('ai-chat-list');
    if (!box) return;
    var ready = cfgReady();
    box.innerHTML = '';
    pushBubble('ai',
      '<div class="ai-welcome-title">👋 你好，我是本系统的 AI 分析助手</div>' +
      '<div class="ai-welcome-sub">可以帮你：<b>解读数据</b> · <b>给灌溉建议</b> · <b>诊断异常</b> · <b>解答系统/传感器问题</b></div>' +
      (ready
        ? '<div class="ai-welcome-ok">已接入后端模型：<b>' + esc(modelName() || '--') + '</b>　点击下方快捷问题，或直接输入你的问题。</div>'
        : (SRV.cfg
          ? '<div class="ai-welcome-warn">⚠️ 后端已连上，但服务端尚未配置 API Key。请在 <b>server/config.js</b> 填写密钥后重启后端。</div>'
          : '<div class="ai-welcome-warn">⚠️ 连不上 AI 后端：' + esc(SRV.err || '正在检测…') + '</div>'))
    );
  }

  function refreshStatus() {
    var ready = cfgReady();
    var el = $('ai-status-text');
    if (el) {
      el.innerHTML = ready
        ? '🤖 ' + esc(modelName() || '--') + ' · 后端 ' + esc(String(getCfg().base).slice(0, 32))
        : (SRV.cfg ? '🤖 后端已连 · 服务端未配置密钥' : '🤖 后端未连接');
    }
    var bar = $('ai-ctx-summary');
    if (bar) {
      var ctx = UI.getContext ? UI.getContext() : {};
      var recs = (ctx.records || []).length;
      bar.textContent = (recs ? '当前分析时段 ' + recs + ' 条样本' : '仅最新读数（无时段样本）') +
        (ctx.lastUpdate ? ' · 更新于 ' + ctx.lastUpdate : '');
    }
  }

  function renderQuick() {
    var box = $('ai-quick');
    if (!box) return;
    box.innerHTML = QUICK.map(function (q, i) {
      return '<div class="ai-chip" data-i="' + i + '"><span class="ai-chip-ico">' + q.icon + '</span>' +
        '<span class="ai-chip-text">' + esc(q.title) + '</span></div>';
    }).join('');
    box.querySelectorAll('.ai-chip').forEach(function (el) {
      el.addEventListener('click', function () {
        var q = QUICK[Number(el.dataset.i)];
        if (q) { $('ai-input').value = q.q; send(q.q); }
      });
    });
  }

  function buildMessages(userText, withCtx) {
    var msgs = [{ role: 'system', content: SYSTEM }];
    var ctxText = '';
    if (withCtx && UI.getContext) {
      try { ctxText = buildContext(UI.getContext()); } catch (e) { ctxText = ''; }
    }
    // 只保留最近 8 轮对话，防止上下文无限膨胀
    var recent = UI.history.slice(-16);
    recent.forEach(function (m) { if (m.role !== 'system') msgs.push(m); });
    if (ctxText) {
      msgs.push({ role: 'user', content: ctxText + '\n\n=== 我的问题 ===\n' + userText });
    } else {
      msgs.push({ role: 'user', content: userText });
    }
    return msgs;
  }

  function setSending(on) {
    UI.sending = on;
    var send = $('ai-send'), stop = $('ai-stop');
    if (send) send.classList.toggle('hidden', on);
    if (stop) stop.classList.toggle('hidden', !on);
  }

  function send(text) {
    text = String(text || '').trim();
    if (!text || UI.sending) return;
    // 还没拿到后端状态：先去问一次，拿到再决定发不发
    if (!SRV.cfg) {
      var wait = pushBubble('sys', '正在连接 AI 后端…');
      fetchServerCfg(true).then(function () {
        if (wait && wait.parentNode) wait.parentNode.removeChild(wait);
        if (cfgReady()) doSend(text);
        else {
          pushBubble('sys', '⚠️ ' + esc(SRV.err || 'AI 后端不可用') + '　详情见「⚙️ 系统设置 → 🤖 AI 助手」。');
          if (UI.jumpSettings) UI.jumpSettings();
        }
      });
      return;
    }
    if (!cfgReady()) {
      pushBubble('sys', '⚠️ ' + esc(SRV.err || '服务端尚未配置 API Key') +
        (SRV.cfg ? '　请在 server/config.js 填写密钥后重启后端。' : '　详情见「⚙️ 系统设置 → 🤖 AI 助手」。'));
      if (UI.jumpSettings) UI.jumpSettings();
      return;
    }
    doSend(text);
  }

  function doSend(text) {
    var input = $('ai-input');
    if (input) input.value = '';
    UI.history.push({ role: 'user', content: text });
    pushBubble('user', esc(text));

    var useCtx = true;
    var cb = $('ai-ctx-toggle');
    if (cb) useCtx = !!cb.checked;

    var id = 'ai-ans-' + Date.now();
    pushBubble('ai', '<span class="ai-typing">思考中<span class="ai-dots"><i>.</i><i>.</i><i>.</i></span></span>', id);
    setSending(true);

    var msgs = buildMessages(text, useCtx);
    var acc = '';
    var reasoned = false;
    var opt = {
      stream: true,
      maxTokens: 4096,          // 推理型模型要先消耗一批思维链 token，给足余量
      onDelta: function (chunk) {
        var el = $(id);
        if (!el) return;
        acc += chunk;
        var bub = el.querySelector('.ai-bubble');
        if (bub) bub.innerHTML = md(acc) + '<span class="ai-caret"></span>';
        scrollBottom();
      },
      /* 推理模型在吐正文之前会先吐一大段思维链，这段时间别让界面干瞪眼 */
      onReason: function () {
        if (acc || reasoned) return;
        reasoned = true;
        var el = $(id);
        if (!el) return;
        var bub = el.querySelector('.ai-bubble');
        if (bub) bub.innerHTML = '<span class="ai-typing">🧠 推理模型思考中<span class="ai-dots"><i>.</i><i>.</i><i>.</i></span></span>';
      }
    };
    var p = chat(msgs, opt);
    // chat() 同步把 AbortController 挂到 opt._controller 上，"停止"按钮靠它中断
    UI.ctrl = opt._controller || null;
    p.then(function (r) {
      var el = $(id);
      if (!el) return;
      var bub = el.querySelector('.ai-bubble');
      // 用户主动中断：不报错，保留已生成的部分内容
      var aborted = !!UI.aborted;
      UI.aborted = false;
      if (!r.ok && !aborted) {
        bub.innerHTML = '<span class="ai-err">❌ ' + esc(r.msg || '请求失败') + '</span>' +
          (acc ? '<div class="ai-partial">' + md(acc) + '</div>' : '');
      } else {
        var final = r.text || acc;
        if (!final) bub.innerHTML = '<span class="ai-err">⚠️ 模型返回了空内容，请换个问法或检查模型是否支持该请求。</span>';
        else bub.innerHTML = md(final);
        UI.history.push({ role: 'assistant', content: final });
      }
      scrollBottom();
      setSending(false);
      UI.ctrl = null;
    });
  }

  function bindUI() {
    var btn = $('ai-send');
    if (btn) btn.addEventListener('click', function () {
      var t = $('ai-input').value; send(t);
    });
    var input = $('ai-input');
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
      });
    }
    var stop = $('ai-stop');
    if (stop) stop.addEventListener('click', function () {
      UI.aborted = true;
      if (UI.ctrl) { try { UI.ctrl.abort(); } catch (e) {} }
      setSending(false);
      var box = $('ai-chat-list');
      if (box) {
        var last = box.querySelector('.ai-caret');
        if (last) last.remove();
      }
    });
    var clear = $('ai-clear-btn');
    if (clear) clear.addEventListener('click', function () {
      UI.history = [];
      renderWelcome();
    });
    var copy = $('ai-copy-btn');
    if (copy) copy.addEventListener('click', function () {
      var txt = UI.history.filter(function (m) { return m.role === 'assistant'; })
        .map(function (m) { return m.content; }).join('\n\n---\n\n');
      if (!txt) { return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () {
          copy.textContent = '✅ 已复制'; setTimeout(function () { copy.textContent = '📋 复制回答'; }, 1500);
        });
      }
    });
    renderQuick();
    renderWelcome();
    refreshStatus();
    // 启动后立刻探一次后端，把「模型名 / 是否已配置密钥」显示出来
    fetchServerCfg(true).then(function () {
      renderWelcome();
      refreshStatus();
    });
  }

  global.AIAgent = {
    DEFAULTS: DEFAULTS,
    KEYS: K,
    SYSTEM: SYSTEM,
    QUICK: QUICK,
    getCfg: getCfg,
    saveCfg: saveCfg,
    cfgReady: cfgReady,
    endpoint: endpoint,
    serverCfg: function () { return SRV.cfg; },
    serverError: function () { return SRV.err; },
    refreshServer: fetchServerCfg,
    testConnection: testConnection,
    listModels: listModels,
    chat: chat,
    buildContext: buildContext,
    /* ---- UI ---- */
    init: function (opt) {
      UI.getContext = (opt && opt.getContext) || null;
      UI.jumpSettings = (opt && opt.jumpSettings) || null;
      bindUI();
    },
    onShow: function () { refreshStatus(); },
    renderWelcome: renderWelcome,
    UI: UI
  };
})(window);
