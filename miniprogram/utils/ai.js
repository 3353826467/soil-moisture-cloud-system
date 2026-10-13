/* ============================================================
 * utils/ai.js — AI 轻量问答（后端接入版）
 * ------------------------------------------------------------
 * 小程序侧只做三件事：
 *   1) 记住后端地址（server/server.js 的 /api/ai）
 *   2) 把页面数据拼成一段文字上下文
 *   3) 发一次非流式问答，拿回整段回答
 *
 * 与网页端的关键差异：
 *   · 这里没有密钥的概念，密钥在后端；小程序只认后端地址
 *   · wx.request 流式能力受基础库限制，所以走 stream:false 一次性拿全文
 *   · 不做多轮对话历史，一次一问一答，够用且省 token
 * ============================================================ */

var KEY = { base: 'ai_api_base' };
var DEFAULTS = { base: '' };   // 小程序没有"同源"，地址必须由用户在设置页填写

/* ---------------- 配置 ---------------- */
function getCfg() {
  var b = wx.getStorageSync(KEY.base);
  return { base: b == null ? DEFAULTS.base : String(b).trim() };
}
function saveCfg(c) {
  wx.setStorageSync(KEY.base, String((c && c.base) || '').trim());
}
function cfgReady(c) {
  c = c || getCfg();
  return /^https?:\/\//i.test(c.base);
}
function api(path) {
  return String(getCfg().base || '').replace(/\/+$/, '') + '/' + path;
}

/* ---------------- 错误翻译 ---------------- */
function errText(status, body) {
  var m = '';
  try {
    var j = JSON.parse(body);
    m = (j && (j.msg || (j.error && (j.error.message || j.error.code)) || j.message)) || '';
  } catch (e) { m = String(body || '').slice(0, 120); }
  m = String(m || '').trim();
  var head;
  if (status === 401) head = '401 未授权';
  else if (status === 404) head = '404 后端地址不对';
  else if (status === 429) head = '429 请求太频繁或并发已满';
  else if (status >= 500) head = status + ' 后端错误';
  else if (status) head = status + ' 请求失败';
  else head = '请求失败';
  return head + (m ? '｜' + m.slice(0, 120) : '');
}

/* 小程序最常见的两种失败：没填/没加合法域名、后端压根没起 */
function domainHint() {
  return '连不上 AI 后端。请确认：①后端已启动（node server/server.js）；' +
    '②设置页填的地址是 http(s):// 开头的完整地址；' +
    '③小程序后台「开发管理 → 服务器域名」已加入该域名（开发阶段可在开发者工具勾选"不校验合法域名"）。';
}

/* ---------------- 请求 ---------------- */
function post(path, payload, timeout) {
  return new Promise(function (resolve) {
    var settled = false;
    var url = api(path);
    var done = function (r) { if (!settled) { settled = true; resolve(r); } };
    setTimeout(function () { done({ ok: false, msg: '请求超时（60 秒无响应）' }); }, timeout || 60000);
    wx.request({
      url: url,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: payload,
      timeout: timeout || 60000,
      success: function (res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          var j = res.data;
          if (typeof j === 'string') { try { j = JSON.parse(j); } catch (e) { j = null; } }
          if (j && j.ok === false) return done({ ok: false, msg: j.msg || '后端返回失败' });
          done({ ok: true, data: j });
          return;
        }
        done({ ok: false, msg: errText(res.statusCode, res.data) });
      },
      fail: function (e) {
        done({ ok: false, msg: domainHint() + (e && e.errMsg ? '（' + e.errMsg + '）' : '') });
      }
    });
  });
}

/* 一次性问答：messages 由 buildMessages 组装，返回 {ok, text, msg} */
function ask(question, ctxText, opt) {
  opt = opt || {};
  if (!cfgReady()) return Promise.resolve({ ok: false, msg: '尚未配置 AI 后端地址，请到「设置」填写' });
  var msgs = [{ role: 'system', content: SYSTEM }];
  if (ctxText) msgs.push({ role: 'user', content: ctxText });
  msgs.push({ role: 'user', content: question });
  return post('chat', {
    messages: msgs,
    temperature: opt.temp,
    stream: false
  }).then(function (r) {
    if (!r.ok) return { ok: false, msg: r.msg };
    var d = r.data || {};
    var text = d.text || (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
    return { ok: true, text: String(text).trim(), model: d.model || '' };
  });
}

/* 后端连通性检测：给设置页用 */
function test() {
  if (!cfgReady()) return Promise.resolve({ ok: false, msg: '请先填写后端地址' });
  var t0 = Date.now();
  return post('test', {}, 30000).then(function (r) {
    if (!r.ok) return { ok: false, msg: r.msg, latency: Date.now() - t0 };
    var d = r.data || {};
    return {
      ok: true,
      msg: '后端可用',
      model: d.model || '',
      latency: (d.latency != null ? d.latency : Date.now() - t0),
      reply: d.reply || ''
    };
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
  '· 这是小程序屏幕，回答控制在 400 字以内，用短句和换行，不要写大段长段落；',
  '· 【重要】不要使用 Markdown 语法：不要写 #、**、| 表格，序号用 1. 2. 3. 即可，否则手机上会看到一堆符号；',
  '· 给出灌溉/施肥/打药等建议时，必须提示结合田间实际情况复核；',
  '· 不确定的技术细节要说明不确定，不要装作确定。'
].join('\n');

/* 兜底清理：万一模型还是吐了 Markdown 符号，在这层剥掉，保证 text 组件里好看 */
function stripMarkdown(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, function (m) { return m.replace(/```/g, ''); })
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

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

/* ctx = { latest:{sh,st,ah,at}, rssi, lastUpdate, topic, thr:{}, an:{}, records:[] } */
function buildContext(ctx) {
  ctx = ctx || {};
  var L = [];
  var thr = ctx.thr || {};
  var latest = ctx.latest || null;
  var an = ctx.an || {};

  L.push('=== 农田土壤墒情系统 · 数据上下文 ===');
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
  L.push('· 土壤湿度：轻旱线 ' + n1(thr.shLow, 0) + ' %，适宜上界 ' + n1(thr.shOpt, 0) + ' %');
  L.push('· 土壤温度：' + n1(thr.stLow, 0) + ' ~ ' + n1(thr.stHi, 0) + ' ℃');
  L.push('· 空气湿度：' + n1(thr.ahLow, 0) + ' ~ ' + n1(thr.ahHi, 0) + ' %');
  L.push('· 空气温度：' + n1(thr.atLow, 0) + ' ~ ' + n1(thr.atHi, 0) + ' ℃');

  var recs = ctx.records || [];
  if (recs.length) {
    L.push('');
    L.push('【当前分析时段】' + (an.startDate ? an.startDate + ' ' + (an.startTime || '00:00') : '--') +
      ' ~ ' + (an.endDate ? an.endDate + ' ' + (an.endTime || '23:59') : '--'));
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
        ' / 均值 ' + n1(avg) + ' / 中位数 ' + n1(med) + ' / 标准差 ' + n1(std));
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

    // 原始采样等距抽稀，最多 40 行，防止把 token 吃光
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
    L.push('【当前分析时段】暂无（当前只带最新读数，看不到趋势）');
  }

  L.push('');
  L.push('（以上为系统自动附加的真实数据，请基于这些数据分析作答，不要编造未给出的数值。）');
  return L.join('\n');
}

module.exports = {
  KEY: KEY,
  DEFAULTS: DEFAULTS,
  SYSTEM: SYSTEM,
  getCfg: getCfg,
  saveCfg: saveCfg,
  cfgReady: cfgReady,
  api: api,
  ask: ask,
  test: test,
  buildContext: buildContext,
  stripMarkdown: stripMarkdown
};
