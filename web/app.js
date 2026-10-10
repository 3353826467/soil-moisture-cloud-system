/* ============================================================
 * 农田土壤墒情云端采集与数据分析系统 —— 网页版（纯前端，无后端）
 * 功能与微信小程序完全一致：实时监测 / 阈值下发 / 远程控制 / 历史分析 / 导出
 * 数据源：巴法云 HTTP API（已确认返回 Access-Control-Allow-Origin: *，浏览器可直接调用）
 * ============================================================ */

/* 私有配置来自同目录 config.js（仓库自带占位模板）与 config.local.js（本地真实值，不入库）*/
const APP_CFG = (typeof window !== 'undefined' && window.APP_CONFIG) ? window.APP_CONFIG : {};

const CFG = {
  API_HOST: 'https://apis.bemfa.com',
  DEFAULT_UID: APP_CFG.DEFAULT_UID || '',
  DEFAULT_TOPIC: APP_CFG.DEFAULT_TOPIC || 'Test01',
  DEFAULT_POLL: 30000
};

/* ---------------- 全局状态（localStorage 持久化） ---------------- */
function loadUID() {
  const s = localStorage.getItem('bemfa_cfg');
  if (s) { try { const o = JSON.parse(s); if (o.uid && o.topic) return o; } catch (e) {} }
  return { uid: CFG.DEFAULT_UID, topic: CFG.DEFAULT_TOPIC };
}
let STATE = {
  uid: CFG.DEFAULT_UID,
  topic: CFG.DEFAULT_TOPIC,
  pollMs: CFG.DEFAULT_POLL
};
(function initState() {
  const c = loadUID();
  STATE.uid = c.uid; STATE.topic = c.topic;
  const p = parseInt(localStorage.getItem('poll_ms'), 10);
  if (p >= 1000) STATE.pollMs = p;
})();

const MAX_NUM = 5000;
/* ---------------- 本地累积缓存（突破云端 5000 条 / 保留期限制） ---------------- */
const HIST_KEY = 'bemfa_hist_v1';
const HIST_MAX = 20000;

function loadHist() {
  try {
    const s = localStorage.getItem(HIST_KEY);
    if (!s) return [];
    const a = JSON.parse(s);
    if (!Array.isArray(a)) return [];
    return a.filter(r => r && typeof r.unix === 'number' && r.unix > 0 && typeof r.sh === 'number');
  } catch (e) { return []; }
}

function saveHist(list) {
  let out = list.length > HIST_MAX ? list.slice(list.length - HIST_MAX) : list.slice();
  for (let i = 0; i < 5; i++) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(out)); return out.length; }
    catch (e) { out = out.slice(Math.floor(out.length / 2)); }
  }
  try { localStorage.removeItem(HIST_KEY); } catch (e) {}
  return 0;
}

function mergeRecs(cached, fresh) {
  const map = new Map();
  (cached || []).concat(fresh || []).forEach(r => {
    if (!r || !(r.unix > 0)) return;
    map.set(r.unix, r);
  });
  return Array.from(map.values()).sort((a, b) => a.unix - b.unix);
}

function clearHist() {
  try { localStorage.removeItem(HIST_KEY); } catch (e) {}
}

/* 先用本地缓存渲染，再联网增量更新——断网也能看历史 */
function renderFromCache() {
  const c = loadHist();
  if (!c.length) return false;
  allRecords = c;
  anState.cloudCount = 0;
  anState.cacheCount = c.length;
  buildDateBounds(c, 0);
  anState.loading = false;
  anState.empty = false;
  anState.totalAll = c.length;
  anState.lastUpdate = '本地缓存 · ' + fmtDateClock(Date.now());
  const u = $('an-update'); if (u) u.textContent = anState.lastUpdate;
  applyFilter();
  return true;
}


/* ---------------- 通用工具 ---------------- */
const $ = (id) => document.getElementById(id);
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 1600);
}

const METRICS = [
  { key: 'sh', name: '土壤湿度', unit: '%', band: [45, 65], color: '#2e86ab', dec: 0 },
  { key: 'st', name: '土壤温度', unit: '℃', band: [15, 25], color: '#d1495b', dec: 1 },
  { key: 'ah', name: '空气湿度', unit: '%', band: [50, 80], color: '#3aa17e', dec: 0 },
  { key: 'at', name: '空气温度', unit: '℃', band: [18, 28], color: '#ed8b00', dec: 1 }
];
let LEVELS = [
  { name: '重旱', min: -Infinity, max: 30, color: '#d1495b' },
  { name: '轻旱', min: 30, max: 45, color: '#ed8b00' },
  { name: '适宜', min: 45, max: 65, color: '#3aa17e' },
  { name: '过湿', min: 65, max: 80, color: '#2e86ab' },
  { name: '积水', min: 80, max: Infinity, color: '#7b5ea7' }
];
// 顶部镜像派生 shHi：过湿带宽度 = 适宜带宽度 → shHi = shOpt + (shOpt - shLow)，夹紧 ≤100。
// 底部重旱阈值固定 30（生理常量），不参与派生。
function deriveShHi(shLow, shOpt) {
  const hi = shOpt + (shOpt - shLow);
  return Math.min(100, Math.max(shOpt + 1, Math.round(hi)));
}

// 等级分档随远程阈值动态重建：重旱<30(固定) | 轻旱[30,shLow) | 适宜[shLow,shOpt) | 过湿[shOpt,shHi) | 积水≥shHi
function recomputeLevels() {
  const toNum = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  const shLow = toNum(homeThr.shLow, 45), shOpt = toNum(homeThr.shOpt, 65);
  const rawShHi = Number(homeThr.shHi);
  const shHi = (isFinite(rawShHi) && rawShHi > 0) ? rawShHi : deriveShHi(shLow, shOpt);
  LEVELS = [
    { name: '重旱', min: -Infinity, max: 30, color: '#d1495b' },
    { name: '轻旱', min: 30, max: shLow, color: '#ed8b00' },
    { name: '适宜', min: shLow, max: shOpt, color: '#3aa17e' },
    { name: '过湿', min: shOpt, max: shHi, color: '#2e86ab' },
    { name: '积水', min: shHi, max: Infinity, color: '#7b5ea7' }
  ];
  METRICS[0].band = [shLow, shOpt];  // 土壤湿度适宜带随阈值同步
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function toMs(u) {
  const n = Number(u);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}
function parseTimeStr(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}
function dateKey(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function shiftDay(key, delta) {
  const p = String(key).split('-');
  if (p.length !== 3) return key;
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setDate(d.getDate() + delta);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function todayKey() { return dateKey(Date.now()); }
function nowHM() { const d = new Date(); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!isFinite(n)) return null;
  if (n <= -99) return null;
  return n;
}
function fmt(n, dec) {
  if (n === null || n === undefined || isNaN(n)) return '--';
  return Number(n).toFixed(dec);
}
function fmtClock(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtDateClock(ms) {
  if (!ms) return '--';
  const d = new Date(ms);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtFull(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; nu += a * b; dx += a * a; dy += b * b; }
  if (dx === 0 || dy === 0) return null;
  return nu / Math.sqrt(dx * dy);
}
function corrClass(r) {
  if (r === null) return 'corr-none';
  const a = Math.abs(r);
  if (a >= 0.7) return 'corr-strong';
  if (a >= 0.4) return 'corr-mid';
  if (a >= 0.2) return 'corr-weak';
  return 'corr-none';
}
function corrText(r) {
  if (r === null) return '样本不足';
  return (r >= 0 ? '+' : '') + r.toFixed(3);
}
function lerpColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t)
  ];
}
function corrColor(r) {
  if (r === null || r === undefined) return [220, 224, 228];
  const t = (Math.max(-1, Math.min(1, r)) + 1) / 2;
  const red = [215, 48, 39], yellow = [255, 255, 191], green = [26, 152, 80];
  return t < 0.5 ? lerpColor(red, yellow, t * 2) : lerpColor(yellow, green, (t - 0.5) * 2);
}
function levelOf(sh) {
  for (let i = 0; i < LEVELS.length; i++) if (sh >= LEVELS[i].min && sh < LEVELS[i].max) return LEVELS[i].name;
  return LEVELS[LEVELS.length - 1].name;
}
function linregress(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const mx = sx / n, my = sy / n;
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; nu += a * b; dx += a * a; dy += b * b; }
  const r = (dx === 0 || dy === 0) ? 0 : nu / Math.sqrt(dx * dy);
  return { slope, intercept, r, r2: r * r };
}

/* ARIMA(0,1,1) 单步滚动预测（≈EMA）。输入数值数组，返回下一时刻预测。
   公式: ŷ_t = y_{t-1} + θ·(y_{t-1} - ŷ_{t-1})；θ 在滚动窗口内最小二乘估计。 */
function arimaOneStep(arr) {
  const a = (arr || []).filter(v => typeof v === 'number' && isFinite(v));
  if (a.length < 4) return null;
  const sub = a.slice(-60);                 // 滚动窗口 60 点
  let num = 0, den = 0;
  for (let i = 2; i < sub.length; i++) {
    const dy = sub[i] - sub[i - 1], dy1 = sub[i - 1] - sub[i - 2];
    num += dy * dy1; den += dy1 * dy1;
  }
  const theta = den > 1e-9 ? Math.min(1, Math.max(0, num / den)) : 0.5;
  let predPrev = sub[0], errSq = 0, n = 0;
  for (let i = 1; i < sub.length; i++) {
    const pred = sub[i - 1] + theta * (sub[i - 1] - predPrev);
    errSq += (sub[i] - pred) * (sub[i] - pred); n++;
    predPrev = pred;
  }
  const next = sub[sub.length - 1] + theta * (sub[sub.length - 1] - predPrev);
  const rmse = n ? Math.sqrt(errSq / n) : 0;
  return { next: next, theta: theta, rmse: rmse };
}

/* ---------------- 巴法云接口封装 ---------------- */
async function bemfaGet(num) {
  const url = CFG.API_HOST + '/va/getmsg?uid=' + encodeURIComponent(STATE.uid) +
    '&topic=' + encodeURIComponent(STATE.topic) + '&type=1&num=' + num;
  const res = await fetch(url, { cache: 'no-store' });
  return res.json();
}
async function bemfaPost(msg) {
  const fd = new URLSearchParams();
  fd.set('uid', STATE.uid);
  fd.set('topic', STATE.topic);
  fd.set('type', '1');
  fd.set('msg', msg);
  const res = await fetch(CFG.API_HOST + '/va/postmsg', { method: 'POST', body: fd });
  return res.json();
}

/* ============================================================
 * 路由
 * ============================================================ */
const ROUTES = { home: 'view-home', analysis: 'view-analysis', threshold: 'view-threshold', settings: 'view-settings' };
let homeTimer = null;

function showRoute(route) {
  Object.keys(ROUTES).forEach(k => $(ROUTES[k]).classList.toggle('hidden', k !== route));
  document.querySelectorAll('.topnav a').forEach(a =>
    a.classList.toggle('active', a.dataset.route === route));
  // 首页定时器管理
  if (route === 'home') {
    startHomeTimer();
    startTodayTimer();
    fetchLatest();
    fetchTodayRecords(true);   // 进入首页立即拉今日实时时序图
  } else {
    if (homeTimer) { clearInterval(homeTimer); homeTimer = null; }
    stopTodayTimer();
  }
  if (route === 'analysis') {
    loadSettingsIntoAnalysis();
    renderFromCache();
    fetchHistory(false);   // 按所选时段自动选数据源（当天=巴法云30s / 历史=云端数据库）
  } else {
    stopAnalysisPoll();                     // 离开分析页停掉轮询
  }
  if (route === 'threshold') {
    renderHomeThrInputs();
  }
  if (route === 'settings') {
    loadSettingsIntoForm();
  }
  window.scrollTo(0, 0);
}
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  return ROUTES[h] ? h : 'home';
}
window.addEventListener('hashchange', () => showRoute(currentRoute()));
window.addEventListener('DOMContentLoaded', () => {
  if (!location.hash) location.hash = '#/';
  showRoute(currentRoute());
  bindHome();
  bindThreshold();
  bindSettings();
  bindAnalysis();
  bindZoom();
  restoreIrr();       // 从缓存恢复灌溉状态与起始时刻（刷新页面不丢"正在灌溉中"）
  startIrrTimer();    // 1s 刷新"已持续 mm:ss"
});

/* ============================================================
 * 首页
 * ============================================================ */
let homeThr = { shLow: 45, shHi: 80, shOpt: 65, stLow: 15, stHi: 25, ahLow: 50, ahHi: 80, atLow: 18, atHi: 28 };
(function initThr() {
  const toNum = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  // shHi 不再由用户输入/缓存决定：顶部镜像法强制派生（过湿带宽度 = 适宜带宽度）
  const need = ['shLow','shOpt','stLow','stHi','ahLow','ahHi','atLow','atHi'];
  const t = localStorage.getItem('thr');
  if (t) {
    try {
      const parsed = JSON.parse(t);
      need.forEach(k => {
        const v = parsed[k];
        if (v !== '' && v != null) {
          const n = Number(v);
          if (isFinite(n)) homeThr[k] = n;
        }
      });
    } catch (e) {}
  }
  // 兜底：任一阈值非法则回落到默认值，避免后续比较/区间计算出现 NaN
  const dShLow = toNum(homeThr.shLow, 45), dShOpt = toNum(homeThr.shOpt, 65);
  const dShHi = deriveShHi(dShLow, dShOpt);
  homeThr = {
    shLow: dShLow, shOpt: dShOpt, shHi: dShHi,
    stLow: toNum(homeThr.stLow, 15), stHi: toNum(homeThr.stHi, 25),
    ahLow: toNum(homeThr.ahLow, 50), ahHi: toNum(homeThr.ahHi, 80),
    atLow: toNum(homeThr.atLow, 18), atHi: toNum(homeThr.atHi, 28)
  };
  recomputeLevels();
})();

function renderHomeThrInputs() {
  $('th-shLow').value = homeThr.shLow; $('th-shOpt').value = homeThr.shOpt;
  $('th-stLow').value = homeThr.stLow; $('th-stHi').value = homeThr.stHi;
  $('th-ahLow').value = homeThr.ahLow; $('th-ahHi').value = homeThr.ahHi;
  $('th-atLow').value = homeThr.atLow; $('th-atHi').value = homeThr.atHi;
  recomputeLevels();
}

/* ============================================================
 * 灌溉状态：设备上报 irr:"ON"/"OFF"，点击按钮时乐观更新本地
 * 目的——灌溉进行中时"远程控制"面板要显式给出"正在灌溉中 + 已持续时长"，
 * 否则用户无法判断继电器当前是开还是关，容易重复下发或忘记关阀。
 * ============================================================ */
const IRR = { on: false, since: 0, timer: null };

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function irrElapsed() {
  if (!IRR.on || !IRR.since) return '00:00';
  const s = Math.max(0, Math.floor((Date.now() - IRR.since) / 1000));
  return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
}

// 归一化：兼容 "ON"/"OFF"、1/0、true/false；设备未上报则维持当前状态
function irrIsOn(v) {
  if (v === undefined || v === null) return IRR.on;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  return String(v).toUpperCase() === 'ON';
}

function setIrr(on) {
  if (on) {
    if (!IRR.on || !IRR.since) IRR.since = Date.now();
    IRR.on = true;
  } else {
    IRR.on = false; IRR.since = 0;
  }
  try { localStorage.setItem('irrState', JSON.stringify({ on: IRR.on, since: IRR.since })); } catch (e) {}
  renderIrr();
}

function renderIrr() {
  const badge = $('irr-badge');
  if (!badge) return;
  const el = irrElapsed();
  badge.className = 'irr-badge ' + (IRR.on ? 'irr-on' : 'irr-off');
  $('irr-badge-text').textContent = IRR.on ? '正在灌溉中' : '未灌溉';
  const btime = $('irr-badge-time');
  btime.hidden = !IRR.on;
  if (IRR.on) btime.textContent = el;
  const banner = $('irr-banner');
  banner.hidden = !IRR.on;
  if (IRR.on) {
    const shTxt = ($('h-sh') && $('h-sh').textContent) ? $('h-sh').textContent : '--';
    $('irr-banner-sub').textContent = '已持续 ' + el + ' · 土壤湿度 ' + shTxt + '% · 点「关闭灌溉」随时停止';
  }
  const on = $('btn-irr-on'), off = $('btn-irr-off');
  on.textContent = IRR.on ? '💧 正在灌溉' : '💧 启动灌溉';
  on.classList.toggle('btn-irr-live', IRR.on);
  off.classList.toggle('btn-stop-live', IRR.on);
}

/* ---- 数据新鲜度：显示"距最新一条上报过去了多久" ----
 * 背景：固件上报周期为 30 s，但实测大量丢报（14.4 h 内仅 300 条，平均 174 s/条）。
 * 若只显示数据时间，用户/答辩评委容易误判为"页面卡住不刷新"，
 * 这里把延迟显式暴露出来，并区分正常等待与设备侧丢报。
 */
let lastDataMs = 0;
function paintFreshness() {
  const el = $('h-fresh');
  if (!el) return;
  if (!lastDataMs) { el.textContent = ''; return; }
  const age = Math.max(0, Date.now() - lastDataMs);
  const s = Math.floor(age / 1000);
  let txt, color;
  if (s < 45) { txt = '刚刚'; color = '#16a34a'; }
  else if (s < 120) { txt = s + ' 秒前'; color = '#16a34a'; }
  else if (s < 300) { txt = Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒前 · 上报延迟'; color = '#d97706'; }
  else { txt = Math.floor(s / 60) + ' 分前 · 设备上报异常'; color = '#dc2626'; }
  el.textContent = txt;
  el.style.color = color;
}

function startIrrTimer() {
  if (IRR.timer) clearInterval(IRR.timer);
  IRR.timer = setInterval(() => { if (IRR.on) renderIrr(); paintFreshness(); }, 1000);
}

// 刷新页面后按缓存续算时长，避免"正在灌溉中"被清零
function restoreIrr() {
  try {
    const c = JSON.parse(localStorage.getItem('irrState') || 'null');
    if (c && c.on && c.since) { IRR.on = true; IRR.since = c.since; }
  } catch (e) {}
  renderIrr();
}

function rssiLabel(r) {
  if (r === undefined || r === null) return '--';
  if (r >= -50) return '极强';
  if (r >= -65) return '强';
  if (r >= -75) return '中';
  if (r >= -85) return '弱';
  return '极弱';
}
function fmtSensor(v) {
  if (v === null || v === undefined) return '--';
  const n = Number(v);
  if (!isFinite(n) || n <= -99) return '--';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

let lastSensor = null;  // 最近一次有效读数（原始数字），"保存阈值"后用它立即重算建议

function computeHomeAdvice(sh, st, at, ah) {
  // homeThr 可能被旧缓存/设备回传污染成字符串或 NaN，使用前统一归一化
  const toNum = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  const aShLow = toNum(homeThr.shLow, 45), aShOpt = toNum(homeThr.shOpt, 65);
  const aRawShHi = Number(homeThr.shHi);
  const aShHi = (isFinite(aRawShHi) && aRawShHi > 0) ? aRawShHi : deriveShHi(aShLow, aShOpt);
  const thr = {
    shLow: aShLow, shOpt: aShOpt, shHi: aShHi,
    stLow: toNum(homeThr.stLow, 15), stHi: toNum(homeThr.stHi, 25),
    ahLow: toNum(homeThr.ahLow, 50), ahHi: toNum(homeThr.ahHi, 80),
    atLow: toNum(homeThr.atLow, 18), atHi: toNum(homeThr.atHi, 28)
  };
  let advIcon = '✅', advSummary = '土壤湿度适宜', advText = '', advLevel = 'advice-normal';
  if (!isFinite(sh)) {
    advIcon = '⏳'; advSummary = '等待传感器数据…';
    advText = '请确保土壤湿度传感器连接正常。';
    advLevel = 'advice-warn';
  } else if (sh < 30) {
    advIcon = '🚨'; advSummary = '土壤严重缺水，建议立即灌溉';
    advText = '当前湿度仅 ' + sh.toFixed(1) + '%，处于重旱区间（<30%），作物根系可能受损，请尽快启动灌溉，或开启自动灌溉。';
    advLevel = 'advice-danger';
  } else if (sh < thr.shLow) {
    advIcon = '⚠️'; advSummary = '土壤轻度缺水，建议近期灌溉';
    advText = '当前湿度 ' + sh.toFixed(1) + '% 低于阈值下限 ' + thr.shLow + '%，建议优先在清晨或傍晚灌溉，减少蒸发。';
    advLevel = 'advice-warn';
  } else if (sh < thr.shOpt) {
    advIcon = '✅'; advSummary = '土壤湿度适宜';
    advText = '当前湿度 ' + sh.toFixed(1) + '% 处于适宜区间 [' + thr.shLow + '%,' + thr.shOpt + '%），作物生长良好，维持现状即可。';
    advLevel = 'advice-normal';
  } else if (sh < thr.shHi) {
    advIcon = '💧'; advSummary = '土壤偏湿，暂缓灌溉';
    advText = '当前湿度 ' + sh.toFixed(1) + '% 处于偏湿区间 [' + thr.shOpt + '%,' + thr.shHi + '%)，土壤过湿，建议加强通风并暂缓灌溉，注意根系病害风险。';
    advLevel = 'advice-warn';
  } else {
    advIcon = '🌊'; advSummary = '土壤积水，建议排水检查';
    advText = '当前湿度 ' + sh.toFixed(1) + '%，疑似积水（≥' + thr.shHi + '%），请立即检查排水沟并暂停灌溉，避免烂根。';
    advLevel = 'advice-danger';
  }
  // 同步提示：土壤温度偏低 / 空气温湿度偏高
  const extras = [];
  if (isFinite(st) && st > -99 && st < thr.stLow) extras.push('土壤温度 ' + st.toFixed(1) + '℃ 偏低，注意保温');
  if (isFinite(at) && at > -99 && at > thr.atHi) extras.push('空气温度 ' + at.toFixed(1) + '℃ 偏高，加强通风');
  if (isFinite(ah) && ah > -99 && ah > thr.ahHi) extras.push('空气湿度 ' + Math.round(ah) + '% 偏高，注意病害');
  if (extras.length) {
    advText += '（同步提示：' + extras.join('；') + '。）';
    if (extras.length > 1 && advLevel === 'advice-warn') advLevel = 'advice-danger';
  }
  return { advIcon: advIcon, advSummary: advSummary, advText: advText, advLevel: advLevel };
}

function paintHomeAdvice(a) {
  try {
    $('h-advice').className = 'advice-card ' + a.advLevel;
    $('h-adv-ico').textContent = a.advIcon;
    $('h-adv-sub').textContent = a.advSummary;
    $('h-adv-text').textContent = a.advText;
  } catch (e) { console.error('advice DOM update failed', e); }
}

// 首页 4 个 KPI 卡完整上色：主数值 + 阈值 + 环形/进度/标签
// （首次接入时只写了 h-sh/h-st 两个主数值，h-ah/h-at/thr/ring/pct/bar/tag 均未写入，
//  导致空气温湿度 KPI 与所有装饰字段全部停留在默认占位符 "--" 状态。）
function paintKpi(obj) {
  try {
    const shV = Number(obj.sh), stV = Number(obj.st), ahV = Number(obj.ah), atV = Number(obj.at);
    const set = function (id, t) { const el = $(id); if (el) el.textContent = t; };

    // 土壤湿度 — 主数值
    set('h-sh', fmtSensor(obj.sh));
    // 阈值文本（脚注用：阈值 X~Y% · 适宜区间）—— 显示适宜区间 shLow~shOpt，
    // 与卡片标签「适宜区间」及小程序阈值输入行口径一致；shHi(积水阈值)为内部派生值，不在脚注展示。
    set('h-sh-thr', homeThr.shLow + '~' + homeThr.shOpt + '%');
    // 适宜区间随远程阈值动态变化（shLow ~ shOpt），与 computeHomeAdvice / 设备 judgeSoilMoisture 一致；设备是唯一真源
    // 环形进度 + 百分比：按 0~100% 截断
    if (isFinite(shV)) {
      const pct = Math.max(0, Math.min(100, shV));
      const ring = $('h-sh-ring-fg');
      if (ring) { ring.setAttribute('stroke-dasharray', '263.9'); ring.setAttribute('stroke-dashoffset', String(263.9 * (1 - pct / 100))); }
      set('h-sh-pct', Math.round(pct) + '%');
    }

    // 土壤温度 — 主数值 + 阈值 + 偏低/正常/偏高 标签
    set('h-st', fmtSensor(obj.st));
    set('h-st-thr', homeThr.stLow + '~' + homeThr.stHi + '℃');
    if (isFinite(stV)) {
      set('h-st-tag', stV < homeThr.stLow ? '偏低' : stV > homeThr.stHi ? '偏高' : '正常');
    }

    // 空气湿度 — 主数值 + 阈值 + 进度条（按 0~100%）
    set('h-ah', fmtSensor(obj.ah));
    set('h-ah-thr', homeThr.ahLow + '~' + homeThr.ahHi + '%');
    if (isFinite(ahV)) {
      const bar = $('h-ah-bar');
      if (bar) bar.style.width = Math.max(0, Math.min(100, ahV)) + '%';
    }

    // 空气温度 — 主数值 + 阈值 + 偏低/正常/偏高 标签
    set('h-at', fmtSensor(obj.at));
    set('h-at-thr', homeThr.atLow + '~' + homeThr.atHi + '℃');
    if (isFinite(atV)) {
      set('h-at-tag', atV < homeThr.atLow ? '偏低' : atV > homeThr.atHi ? '偏高' : '正常');
    }
  } catch (e) { console.error('kpi paint failed', e); }
}

function fetchLatest() {
  if (!STATE.uid || !STATE.topic) { toast('请先到设置页填写配置'); return; }
  bemfaGet(1).then(body => {
    if (body && body.code === 0 && body.data && body.data.length > 0) {
      try {
        const obj = JSON.parse(body.data[0].msg);
        const shNum = Number(obj.sh);
        const level = obj.level || (
          isNaN(shNum) ? '--' :
          shNum < 30 ? '重旱' :
          shNum < homeThr.shLow ? '轻旱' :
          shNum < homeThr.shOpt ? '适宜' :
          shNum < homeThr.shHi ? '过湿' : '积水'
        );
        const lastUpdate = (body.data[0].time && body.data[0].time.indexOf('-') >= 0)
          ? body.data[0].time.slice(11, 19) : fmtClock(Date.now());
        $('h-level').textContent = level;
        paintKpi(obj);
        $('h-topic').textContent = STATE.topic;
        $('h-last').textContent = lastUpdate;
        // 记录数据落库时刻，用于"数据新鲜度"指示：
        // 设备侧丢报时（实测 30s 周期平均 174s 才到一条）前端会明确显示延迟，
        // 避免被误认为页面卡死
        const parsed = Date.parse(String(body.data[0].time || '').replace(/-/g, '/'));
        if (isFinite(parsed)) lastDataMs = parsed;
        paintFreshness();
        $('h-online').textContent = '在线';
        $('h-online').className = 'status-value online';
        $('h-rssi').textContent = rssiLabel(obj.rssi);
        $('h-poll').textContent = Math.round(STATE.pollMs / 1000) + 's';
        // 灌溉状态：设备上报的 irr 是唯一真源，直接覆盖本地乐观值
        setIrr(irrIsOn(obj.irr));
        // 当前读数回填阈值页实时值
        if ($('t-sh')) $('t-sh').textContent = fmtSensor(obj.sh);
        if ($('t-st')) $('t-st').textContent = fmtSensor(obj.st);
        if ($('t-ah')) $('t-ah').textContent = fmtSensor(obj.ah);
        if ($('t-at')) $('t-at').textContent = fmtSensor(obj.at);
        // 缓存原始读数（"保存阈值"后立即用它重算建议，不用等下一帧）
        const stV = Number(obj.st), atV = Number(obj.at), ahV = Number(obj.ah);
        lastSensor = { sh: shNum, st: stV, at: atV, ah: ahV };
        paintHomeAdvice(computeHomeAdvice(shNum, stV, atV, ahV));
        // 设备回传阈值 → 覆盖本地显示（设备是唯一真源）
        // 只覆盖有效字段，避免旧固件缺 shOpt 时把本地阈值冲成 NaN
        if (obj.thr && typeof obj.thr === 'object') {
          const fields = ['shLow','shOpt','stLow','stHi','ahLow','ahHi','atLow','atHi'];
          fields.forEach(k => { const n = Number(obj.thr[k]); if (isFinite(n)) homeThr[k] = n; });
          // shHi 顶部镜像法强制派生：保持前后端一致，避免用户/旧缓存带入非法积水线
          homeThr.shHi = deriveShHi(homeThr.shLow, homeThr.shOpt);
          localStorage.setItem('thr', JSON.stringify(homeThr));
          renderHomeThrInputs();
          // 用新阈值立即重算本次建议，避免本次仍用旧的/空的缓存阈值
          paintHomeAdvice(computeHomeAdvice(shNum, stV, atV, ahV));
          // 诊断：旧版固件（v2 / v3 非 reorganized）不会回传 shOpt，导致网页端 shOpt 无法随设备同步
          if (!isFinite(Number(obj.thr.shOpt))) {
            console.warn('[sync] 设备回传缺少 shOpt，可能运行旧版固件，shOpt 无法从设备同步。建议烧录 v3_reorganized 固件。');
          }
        }
      } catch (e) {
        $('h-online').textContent = '在线'; $('h-online').className = 'status-value online';
        // 最新一条可能是下行命令字符串（irrigate_on/off），而非传感器 JSON。
        // 命令本身也携带灌溉状态，同步后"正在灌溉"不必等下一个上报周期才刷新。
        const raw = String((body.data[0] && body.data[0].msg) || '').trim();
        if (raw === 'irrigate_on' || raw === 'irrigate_pulse_30s') setIrr(true);
        else if (raw === 'irrigate_off') setIrr(false);
      }
    } else {
      $('h-online').textContent = '离线'; $('h-online').className = 'status-value offline';
    }
  }).catch(() => {
    $('h-online').textContent = '离线'; $('h-online').className = 'status-value offline';
  });
}

function startHomeTimer() {
  if (homeTimer) clearInterval(homeTimer);
  homeTimer = setInterval(fetchLatest, STATE.pollMs);
}

let todayTimer = null;
let todayRecords = [];
function startTodayTimer() {
  if (todayTimer) clearInterval(todayTimer);
  todayTimer = setInterval(() => fetchTodayRecords(), 60000);
}
function stopTodayTimer() {
  if (todayTimer) { clearInterval(todayTimer); todayTimer = null; }
}

function fetchTodayRecords(force) {
  if (!STATE.uid || !STATE.topic) return;
  if (force !== true && currentRoute() !== 'home') return;
  bemfaGet(MAX_NUM).then(body => {
    if (!(body && body.code === 0 && Array.isArray(body.data) && body.data.length > 0)) {
      const tip = $('home-four-tip');
      if (tip) tip.textContent = '暂无今日实时数据';
      return;
    }
    const today = todayKey();
    const list = [];
    body.data.forEach(item => {
      try {
        const t = parseTimeStr(item.time);
        if (dateKey(t) !== today) return;
        const obj = JSON.parse(item.msg);
        const sh = num(obj.sh), st = num(obj.st), ah = num(obj.ah), at = num(obj.at);
        if (sh === null || st === null || ah === null || at === null) return;
        list.push({ unix: t, sh, st, ah, at });
      } catch (e) {}
    });
    list.sort((a, b) => a.unix - b.unix);
    todayRecords = list;
    renderHomeFourChart();
  }).catch(() => {
    const tip = $('home-four-tip');
    if (tip) tip.textContent = '拉取实时数据失败，请检查网络';
  });
}

function renderHomeFourChart() {
  const canvas = $('homeFourChart');
  const tip = $('home-four-tip');
  if (!canvas) return;
  if (todayRecords.length === 0) {
    if (tip) tip.textContent = '今日暂无实时数据，请确认设备已上线并上报';
    if (window.homeFourChartInstance) { window.homeFourChartInstance.destroy(); window.homeFourChartInstance = null; }
    return;
  }
  if (typeof window.Chart === 'undefined') return;
  if (window.homeFourChartInstance) { window.homeFourChartInstance.destroy(); window.homeFourChartInstance = null; }

  const ctx = canvas.getContext('2d');
  const labels = [], sh = [], ah = [], st = [], at = [];
  todayRecords.forEach(r => {
    labels.push(fmtTimeLabel(new Date(r.unix)));
    sh.push(r.sh); ah.push(r.ah); st.push(r.st); at.push(r.at);
  });

  const title = '今日实时四指标时序曲线（' + todayKey() + '，n=' + todayRecords.length + '）';
  if (tip) tip.textContent = '土壤湿度 / 空气湿度（左轴 %）与 土壤温度 / 空气温度（右轴 °C）的同步变化 · 今日 ' + todayRecords.length + ' 个采样点';

  window.homeFourChartInstance = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '土壤湿度 (%)', data: sh, borderColor: '#2e86ab', backgroundColor: '#2e86ab', yAxisID: 'y', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: '空气湿度 (%)', data: ah, borderColor: '#3aa17e', backgroundColor: '#3aa17e', yAxisID: 'y', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: '土壤温度 (°C)', data: st, borderColor: '#ed8b00', backgroundColor: '#ed8b00', yAxisID: 'y1', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: '空气温度 (°C)', data: at, borderColor: '#7b5ea7', backgroundColor: '#7b5ea7', yAxisID: 'y1', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: title, font: { size: 15, family: "'PingFang SC','Microsoft YaHei',sans-serif" }, padding: 14 },
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, font: { size: 12 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { ticks: { maxRotation: 30, autoSkip: true, maxTicksLimit: 10, font: { size: 11 } } },
        y: { type: 'linear', position: 'left', title: { display: true, text: '湿度 (%)', font: { size: 12 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: '温度 (°C)', font: { size: 12 } }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

function buildAdvice(sh, st, at, ah) {
  if (!isFinite(sh)) {
    return { icon: '⏳', summary: '等待传感器数据…', text: '请确保土壤湿度传感器连接正常。', level: 'advice-normal' };
  }
  let icon = '🌱', summary = '维持现状', text = '', level = 'advice-normal';
  if (sh < 30) {
    icon = '🚨'; summary = '土壤严重缺水，建议立即灌溉';
    text = '当前湿度仅 ' + sh.toFixed(1) + '%，处于重旱区间（<30%），作物根系可能受损，请尽快启动灌溉，或开启自动灌溉。';
    level = 'advice-danger';
  } else if (sh < homeThr.shLow) {
    icon = '⚠️'; summary = '土壤轻度缺水，建议近期灌溉';
    text = '当前湿度 ' + sh.toFixed(1) + '% 低于阈值下限 ' + homeThr.shLow + '%，建议优先在清晨或傍晚灌溉，减少蒸发。';
    level = 'advice-warn';
  } else if (sh >= homeThr.shLow && sh < homeThr.shOpt) {
    icon = '✅'; summary = '土壤湿度适宜';
    text = '当前湿度 ' + sh.toFixed(1) + '% 处于适宜区间 [' + homeThr.shLow + '%,' + homeThr.shOpt + '%），作物生长良好，维持现状即可。';
    level = 'advice-normal';
  } else if (sh < homeThr.shHi) {
    icon = '💧'; summary = '土壤偏湿，暂缓灌溉';
    text = '当前湿度 ' + sh.toFixed(1) + '% 略高于阈值上限 ' + homeThr.shHi + '%，土壤过湿，建议加强通风并暂缓灌溉，注意根系病害风险。';
    level = 'advice-warn';
  } else {
    icon = '🌊'; summary = '土壤积水，建议排水检查';
    text = '当前湿度 ' + sh.toFixed(1) + '%，疑似积水（≥' + homeThr.shHi + '%），请立即检查排水沟并暂停灌溉，避免烂根。';
    level = 'advice-danger';
  }
  const extra = [];
  if (isFinite(st) && st > -99 && st < homeThr.stLow) extra.push('土壤温度 ' + st.toFixed(1) + '℃ 偏低，注意保温');
  if (isFinite(at) && at > -99 && at > homeThr.atHi) extra.push('空气温度 ' + at.toFixed(1) + '℃ 偏高，加强通风');
  if (isFinite(ah) && ah > -99 && ah > homeThr.ahHi) extra.push('空气湿度 ' + Math.round(ah) + '% 偏高，注意病害');
  if (extra.length) {
    text += '（同步提示：' + extra.join('；') + '。）';
    if (extra.length > 1 && level === 'advice-warn') level = 'advice-danger';
  }
  return { icon, summary, text, level };
}

function bindHome() {
  // 切回页面立即拉取最新数据：避免后台标签页长时间未轮询导致阈值/建议不同步
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && STATE.uid && STATE.topic) { fetchLatest(); fetchTodayRecords(true); }
  });
  $('btn-test-alarm').addEventListener('click', () => postCmd('test_alarm', '测试报警 3 秒'));
  // 点击后乐观更新：不等下一个上报周期（最长 30s）就先显示"正在灌溉中"
  $('btn-irr-on').addEventListener('click', () => { postCmd('irrigate_on', '灌溉启动'); setIrr(true); });
  $('btn-irr-off').addEventListener('click', () => { postCmd('irrigate_off', '灌溉关闭'); setIrr(false); });
  $('btn-home-refresh').addEventListener('click', () => { fetchLatest(); fetchTodayRecords(true); });
  $('btn-analysis').addEventListener('click', () => { location.hash = '#/analysis'; });
}

function bindThreshold() {
  $('btn-save-th').addEventListener('click', () => {
    const raw = {
      shLow: $('th-shLow').value, shOpt: $('th-shOpt').value,
      stLow: $('th-stLow').value, stHi: $('th-stHi').value,
      ahLow: $('th-ahLow').value, ahHi: $('th-ahHi').value,
      atLow: $('th-atLow').value, atHi: $('th-atHi').value
    };
    const need = ['shLow', 'shOpt', 'stLow', 'stHi', 'ahLow', 'ahHi', 'atLow', 'atHi'];
    const obj = {};
    for (const k of need) {
      if (raw[k] === '' || raw[k] == null) { toast('请填写 ' + k); return; }
      if (!isFinite(Number(raw[k]))) { toast('请检查 ' + k + ' 数值'); return; }
      obj[k] = Number(raw[k]);
    }
    // shHi 不再由输入框提供：顶部镜像法自动派生（过湿带宽度 = 适宜带宽度）
    obj.shHi = deriveShHi(obj.shLow, obj.shOpt);
    const pair = [['shLow', 'shHi'], ['stLow', 'stHi'], ['ahLow', 'ahHi'], ['atLow', 'atHi']];
    for (const [lo, hi] of pair) if (obj[lo] >= obj[hi]) { toast(lo + ' 必须小于 ' + hi); return; }
    if (!(obj.shOpt > obj.shLow && obj.shOpt < obj.shHi)) { toast('适宜上界须介于 shLow 与 shHi 之间'); return; }
    localStorage.setItem('thr', JSON.stringify(obj));
    homeThr = obj;
    renderHomeThrInputs();  // 把派生出的 shHi 回填到输入框，给用户可见反馈
    // 立即用新阈值重算"灌溉决策建议"，不用等下一帧（最长 30s）
    if (lastSensor) paintHomeAdvice(computeHomeAdvice(lastSensor.sh, lastSensor.st, lastSensor.at, lastSensor.ah));
    const cmd = 'set_th:shLow=' + obj.shLow + ';shOpt=' + obj.shOpt + ';shHi=' + obj.shHi + ';stLow=' + obj.stLow +
      ';stHi=' + obj.stHi + ';ahLow=' + obj.ahLow + ';ahHi=' + obj.ahHi + ';atLow=' + obj.atLow + ';atHi=' + obj.atHi;
    bemfaPost(cmd).then(r => {
      if (r && r.code !== 0) toast('下发失败 ' + (r.code || ''));
      else toast('阈值已保存');
    }).catch(() => toast('发送失败'));
  });
  // 阈值输入实时预览：用户改动任一输入框时，立即用当前值重算决策建议并刷新 KPI 脚注，
  // 避免输入框和决策建议显示不一致（如输入 100 但建议仍按旧的 65 计算）。
  function previewHomeAdviceFromInputs() {
    const toNum = (v, d) => { if (v === '' || v == null) return d; const n = Number(v); return isFinite(n) ? n : d; };
    const shLow = toNum($('th-shLow').value, homeThr.shLow);
    const shOpt = toNum($('th-shOpt').value, homeThr.shOpt);
    homeThr = {
      shLow: shLow, shOpt: shOpt, shHi: deriveShHi(shLow, shOpt),
      stLow: toNum($('th-stLow').value, homeThr.stLow), stHi: toNum($('th-stHi').value, homeThr.stHi),
      ahLow: toNum($('th-ahLow').value, homeThr.ahLow), ahHi: toNum($('th-ahHi').value, homeThr.ahHi),
      atLow: toNum($('th-atLow').value, homeThr.atLow), atHi: toNum($('th-atHi').value, homeThr.atHi)
    };
    recomputeLevels();
    set('h-sh-thr', homeThr.shLow + '~' + homeThr.shOpt + '%');
    if (lastSensor) paintHomeAdvice(computeHomeAdvice(lastSensor.sh, lastSensor.st, lastSensor.at, lastSensor.ah));
  }
  ['th-shLow', 'th-shOpt', 'th-stLow', 'th-stHi', 'th-ahLow', 'th-ahHi', 'th-atLow', 'th-atHi'].forEach(id => {
    $(id).addEventListener('input', previewHomeAdviceFromInputs);
  });
}
function postCmd(msg, hint) {
  if (!STATE.uid || !STATE.topic) { toast('请先到设置页配置'); return; }
  bemfaPost(msg).then(r => {
    if (r && r.code !== 0) toast('下发失败 ' + (r.code || ''));
    else toast(hint);
  }).catch(() => toast('发送失败'));
}

/* ---------------- 云端历史数据源（腾讯云开发 CloudBase，可选） ----------------
 * 地址留空 = 完全不启用，行为与之前一致。
 * 填了 getHistory 云函数地址后，分析页优先从云数据库读长期历史；
 * 云端不可用（未配置 / 超时 / 报错）时自动回退到巴法云直连 + 本地缓存。
 */
function getCloudBase() {
  try {
    var raw = localStorage.getItem('cloud_base');
    if (raw !== null) return raw.trim(); // 已配置过（含手动清空=恢复本地模式）
  } catch (e) {}
  // 首次打开（未配置过）默认指向本项目 CloudBase 长期归档，直接展示完整历史
  return 'https://nttrsqydcjysjfxxt-d2dszi66e6a29e-1484733482.ap-shanghai.app.tcloudbase.com/getHistory';
}
function getCloudToken() {
  try { return (localStorage.getItem('cloud_token') || '').trim(); } catch (e) { return ''; }
}

function fetchCloudHistory(base, token) {
  if (!base) base = getCloudBase();
  if (!base) { anState.cloudErr = '未配置云端历史接口地址'; return Promise.resolve(null); }
  if (token === undefined) token = getCloudToken();
  // 拉全量历史：from=0 到 now，让 getHistory 在大区间做等间隔抽稀到 limit；
  // 否则 getHistory 默认 from=now-24h，时间跨度会卡在 1~2 天（巴法云单次 5000 条硬上限的视觉效果）。
  let url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'from=0&to=' + Date.now() + '&limit=5000';
  if (token) url += '&token=' + encodeURIComponent(token);
  anState.cloudErr = '';
  return new Promise(function (resolve) {
    var done = false;
    function finish(v, err) { if (!done) { done = true; if (err) anState.cloudErr = err; resolve(v); } }
    setTimeout(function () { finish(null, '云端历史接口超时（12 秒无响应）'); }, 12000);
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.code === 0 && Array.isArray(j.data)) {
        finish({ count: j.data.length, total: j.total || j.data.length, data: j.data });
      } else { finish(null, cloudErrText(j)); }
    }).catch(function (e) {
      finish(null, '云端历史接口网络异常：' + (e && e.message ? e.message : '未知错误'));
    });
  });
}
// 把云端返回的错误码翻译成人话。
// 关键：云函数欠费/停服时前端会静默降级为本地缓存，若不加提示，用户会误以为"历史数据本来就只有这么多"。
function cloudErrText(j) {
  if (!j) return '云端历史接口无响应';
  const c = String(j.code || '');
  const m = String(j.message || j.msg || '');
  if (m.indexOf('InsufficientBalance') >= 0 || m.indexOf('欠费') >= 0)
    return '云端云数据库不可用：云函数账户余额不足（InsufficientBalance），请到腾讯云 CloudBase 控制台充值后恢复';
  if (c === 'FUNCTIONS_INVOCATION_FAILED')
    return '云端云数据库不可用：云函数调用失败（' + m.slice(0, 90) + '）';
  if (c === 'INVALID_PATH')
    return '云端历史接口路径无效，请检查云函数名与部署状态';
  return '云端历史读取失败（' + (c || '无错误码') + ' ' + m.slice(0, 90) + '）';
}

/* ============================================================
 * 设置页
 * ============================================================ */
function loadSettingsIntoForm() {
  $('set-uid').value = STATE.uid;
  $('set-topic').value = STATE.topic;
  $('set-poll').value = Math.round(STATE.pollMs / 1000);
  $('set-topic-show').textContent = STATE.topic || '未配置';
  var cb = $('set-cloud-base'), ct = $('set-cloud-token');
  if (cb) cb.value = getCloudBase();
  if (ct) ct.value = getCloudToken();
}
function bindSettings() {
  $('btn-save-cfg').addEventListener('click', () => {
    const uid = $('set-uid').value.trim();
    const topic = $('set-topic').value.trim();
    if (!uid) { toast('请填写 UID'); return; }
    if (!topic) { toast('请填写主题'); return; }
    if (!/^[0-9a-fA-F]{32}$/.test(uid)) {
      if (!confirm('巴法云 UID 应为 32 位十六进制字符。确认保存吗？')) return;
    }
    STATE.uid = uid; STATE.topic = topic;
    localStorage.setItem('bemfa_cfg', JSON.stringify({ uid, topic }));
    toast('已保存');
    setTimeout(() => { if (currentRoute() !== 'home') location.hash = '#/'; }, 600);
  });
  $('btn-clear-cfg').addEventListener('click', () => {
    if (!confirm('将清除本地配置并恢复默认，确认吗？')) return;
    localStorage.removeItem('bemfa_cfg');
    STATE.uid = CFG.DEFAULT_UID; STATE.topic = CFG.DEFAULT_TOPIC;
    loadSettingsIntoForm(); toast('已恢复默认');
  });
  $('btn-save-poll').addEventListener('click', () => {
    const sec = Number($('set-poll').value);
    if (!isFinite(sec) || sec < 1) { toast('请输入 ≥ 1 秒'); return; }
    if (sec > 60) { toast('最大 60 秒'); return; }
    STATE.pollMs = sec * 1000;
    localStorage.setItem('poll_ms', String(sec * 1000));
    toast('已保存 ' + sec + ' 秒');
  });
  if ($('btn-save-cloud')) $('btn-save-cloud').addEventListener('click', () => {
    const base = $('set-cloud-base').value.trim();
    const token = $('set-cloud-token').value.trim();
    if (base && !/^https?:\/\//i.test(base)) { toast('地址需以 http(s):// 开头'); return; }
    localStorage.setItem('cloud_base', base);
    localStorage.setItem('cloud_token', token);
    toast(base ? '已保存，分析页将优先读云端历史' : '已清空，恢复本地模式');
  });
  if ($('btn-test-cloud')) $('btn-test-cloud').addEventListener('click', () => {
    const base = $('set-cloud-base').value.trim();
    if (!base) { toast('请先填写云函数地址'); return; }
    toast('正在测试连接…');
    const t0 = Date.now();
    fetchCloudHistory(base, $('set-cloud-token').value.trim()).then(r => {
      if (!r) { toast(anState.cloudErr || '连接失败：请检查地址、网络或云函数日志'); return; }
      toast('连接成功：返回 ' + r.count + ' 条（' + (Date.now() - t0) + ' ms）');
    });
  });
}

/* ============================================================
 * 分析页
 * ============================================================ */
const anState = {
  curKey: 'sh', curName: '土壤湿度', curUnit: '%', bandText: '45 ~ 65',
  startDate: '', endDate: '', startTime: '00:00', endTime: '23:59',
  minDate: '', maxDate: '', quick: '',
  cloudErr: '',        // 云端历史最近一次失败原因（为空表示正常）
  total: 0, totalAll: 0, spanText: '--', intervalText: '--', lastUpdate: '--',
  loading: false, empty: false,
  stat: {}, topLevel: '--', topPct: '--',
  corr: {}, corrClass: {}, corrNote: '', adviceText: '', adviceLevel: 'advice-normal',
  forecast: {}, hourly: [], corrMatrix: [], corrMatrixLabels: ['湿度', '土温', '气温', '气湿'],
  corrMatrixKeys: ['sh', 'st', 'at', 'ah'], scatter: {}, reportLines: [],
  // 数据来源模式：'cloud' = 云端数据库(静态拉取) / 'bemfa' = 巴法云(30 秒自动重拉)
  fetchMode: 'cloud'
};
let allRecords = [];
let records = [];
let anPollTimer = null;

// 数据源判定：整个时段都在"今天（含）之后" → 实时（巴法云 30s 自动更新）；
// 一旦时段触及历史（start/end 任一早于今天，如近3天、全部、昨天）→ 云端数据库
function isLiveRange() {
  const start = anState.startDate || '';
  const end = anState.endDate || '';
  if (!start || !end) return true;       // 尚未确定时段，默认实时
  const t = todayKey();
  return start >= t && end >= t;
}
// 时段变化后，依据是否含"今天"重选数据源，必要时切换并重新拉取（保留用户已选时段边界）
function syncAnalysisSource() {
  const want = isLiveRange() ? 'bemfa' : 'cloud';
  // 数据源由所选日期自动决定，禁止手动覆盖；同步 UI 与轮询状态，如模式真的改变再拉取
  const changed = want !== anState.fetchMode;
  setFetchMode(want);
  if (changed) fetchHistory(true);
}

function getFetchMode() {
  try {
    const v = localStorage.getItem('fetch_mode');
    if (v === 'cloud' || v === 'bemfa') return v;
  } catch (e) {}
  return 'cloud';
}
function setFetchMode(mode) {
  if (mode !== 'cloud' && mode !== 'bemfa') mode = 'cloud';
  anState.fetchMode = mode;
  try { localStorage.setItem('fetch_mode', mode); } catch (e) {}
  // 同步按钮 UI（仅在元素存在时）
  const c = $('mode-cloud'), b = $('mode-bemfa');
  if (c) c.classList.toggle('mode-on', mode === 'cloud');
  if (b) b.classList.toggle('mode-on', mode === 'bemfa');
  // 切换时重启分析页轮询
  stopAnalysisPoll();
  if (mode === 'bemfa' && typeof currentRoute === 'function' && currentRoute() === 'analysis') {
    startAnalysisPoll();
  }
}
// 30 秒自动轮询（仅 bemfa 模式下，且用户停留在分析页时生效）
function startAnalysisPoll() {
  stopAnalysisPoll();
  if (anState.fetchMode !== 'bemfa') return;
  anPollTimer = setInterval(function () {
    if (anState.loading) return;
    try { if (currentRoute() === 'analysis') fetchFromBemfa(true); } catch (e) {}
  }, 30000);
}
function stopAnalysisPoll() {
  if (anPollTimer) { clearInterval(anPollTimer); anPollTimer = null; }
}

function loadSettingsIntoAnalysis() {
  $('an-topic') && ($('an-topic').textContent = STATE.topic);
}

function fetchHistory(keepRange) {
  if (!STATE.uid || !STATE.topic) { toast('请先到设置页填写配置'); return; }
  anState.loading = true; $('an-footer').textContent = '正在拉取数据…';
  // 当天数据 → 巴法云实时 + 30 秒自动更新；历史数据 → 云端数据库
  if (isLiveRange()) {
    setFetchMode('bemfa');     // 同步 UI + 启动 30s 轮询
    fetchFromBemfa(keepRange);
    return;
  }
  setFetchMode('cloud');       // 同步 UI + 停止轮询
  anState.lastUpdate = '切换为云端数据库…';
  const up = $('an-update'); if (up) up.textContent = anState.lastUpdate;
  fetchCloudHistory().then(cloud => {
    if (cloud && cloud.data.length) {
      const cached = loadHist();
      const merged = mergeRecs(cached, cloud.data.filter(r => r.unix > 0));
      anState.cacheCount = saveHist(merged);
      anState.cloudCount = cloud.data.length;
      allRecords = merged;
      if (!keepRange) buildDateBounds(allRecords, 0);
      anState.loading = false; anState.empty = false;
      anState.totalAll = allRecords.length;
      anState.lastUpdate = '云端 · ' + fmtDateClock(Date.now());
      const u = $('an-update'); if (u) u.textContent = anState.lastUpdate;
      applyFilter();
      return;
    }
    // 云端历史读取失败：先回退巴法云直连（最近 5000 条 ≈ 41.7h），仍无果才落本地缓存。
    // 缺口修复：之前云端欠费期间直接读本地缓存，页面只剩最后一次缓存那几天。
    if (anState.cloudErr) toast('云端历史不可用，改从巴法云拉取最近数据');
    fetchFromBemfa(keepRange);
  });
}

function fetchFromBemfa(keepRange) {
  bemfaGet(MAX_NUM).then(body => {
    let raw = [];
    if (body && body.code === 0 && Array.isArray(body.data)) raw = body.data;
    const recs = [];
    let noTime = 0;
    raw.forEach(it => {
      let obj = null;
      try { obj = JSON.parse(it.msg); } catch (e) { obj = null; }
      if (!obj || typeof obj !== 'object') return;
      const sh = num(obj.sh);
      if (sh === null) return;
      let ms = toMs(it.unix);
      if (!ms) ms = parseTimeStr(it.time);
      if (!ms) noTime++;
      recs.push({ unix: ms, sh, st: num(obj.st), ah: num(obj.ah), at: num(obj.at) });
    });
    recs.sort((a, b) => (a.unix || 0) - (b.unix || 0));

    // 与本地累积缓存按时间戳去重合并后回写，突破云端单次 5000 条与保留期限制
    const cached = loadHist();
    const merged = mergeRecs(cached, recs.filter(r => r.unix > 0));
    anState.cacheCount = saveHist(merged);
    anState.cloudCount = recs.length;
    allRecords = merged.concat(recs.filter(r => !(r.unix > 0)));

    if (allRecords.length === 0) {
      anState.loading = false; anState.empty = true; anState.total = 0; anState.totalAll = 0;
      $('an-footer').textContent = '该分析时段内没有数据，请调整范围';
      renderFourChart();
      return;
    }
    if (!keepRange) buildDateBounds(allRecords, noTime);   // 轮询刷新时保留用户已选时段
    anState.loading = false; anState.totalAll = allRecords.length;
    anState.lastUpdate = '实时(巴法云) · ' + fmtDateClock(Date.now());
    const u = $('an-update'); if (u) u.textContent = anState.lastUpdate;
    applyFilter();
  }).catch(() => {
    if (keepRange) {   // 轮询刷新失败：保留上一次数据，仅提示
      anState.loading = false;
      anState.lastUpdate = '刷新失败 ' + fmtDateClock(Date.now());
      const u = $('an-update'); if (u) u.textContent = anState.lastUpdate;
      return;
    }
    // 首次/手动拉取失败：回退到本地累积缓存
    const c = loadHist();
    if (c.length) {
      allRecords = c;
      anState.cloudCount = 0; anState.cacheCount = c.length;
      buildDateBounds(c, 0);
      anState.loading = false; anState.empty = false;
      anState.totalAll = c.length;
      anState.lastUpdate = '离线 · 本地缓存 ' + fmtDateClock(Date.now());
      const u = $('an-update'); if (u) u.textContent = anState.lastUpdate;
      applyFilter();
      return;
    }
    anState.loading = false; anState.empty = true;
    $('an-footer').textContent = '拉取失败，请检查网络或配置';
  });
}

function buildDateBounds(recs, noTime) {
  let min = 0, max = 0;
  recs.forEach(r => {
    if (!r.unix) return;
    if (!min || r.unix < min) min = r.unix;
    if (r.unix > max) max = r.unix;
  });
  let minD, maxD, note;
  if (!min || !max) {
    minD = todayKey(); maxD = todayKey();
    note = '';
  } else {
    minD = dateKey(min); maxD = dateKey(max);
    note = '';
  }
  anState.minDate = minD; anState.maxDate = maxD; anState.coverNote = note;
  // 首次进入或无用户选择时才默认到最新数据日；只有最新数据日确实是今天时才高亮"今天"
  if (!anState.startDate) {
    anState.startDate = maxD;
    anState.endDate = maxD;
    anState.startTime = '00:00';
    // 结束日期是今天 → 默认到当前时刻，而非 23:59
    anState.endTime = (maxD === todayKey()) ? nowHM() : '23:59';
    anState.quick = (maxD === todayKey()) ? 'today' : '';
  }
  anState.startTime = anState.startTime || '00:00';
  anState.endTime = anState.endTime || '23:59';
  $('an-start').value = anState.startDate;
  $('an-start-time').value = anState.startTime;
  $('an-end').value = anState.endDate;
  $('an-end-time').value = anState.endTime;
  updateQuickUI();
  const cov = $('an-cover-note'); if (cov) cov.textContent = anState.coverNote || '';
  $('an-range').textContent = anRangeText();
  $('an-update').textContent = anState.lastUpdate;
}

function onStartChange() {
  const v = $('an-start').value; if (v) anState.startDate = v;
  anState.quick = ''; normalizeRange(); syncRangeInputs(); applyFilter();
  syncAnalysisSource();
}
function onEndChange() {
  const v = $('an-end').value; if (v) anState.endDate = v;
  anState.quick = ''; normalizeRange(); syncRangeInputs(); applyFilter();
  syncAnalysisSource();
}
function onStartTimeChange() {
  const v = $('an-start-time').value; if (v) anState.startTime = v;
  anState.quick = ''; normalizeRange(); syncRangeInputs(); applyFilter();
}
function onEndTimeChange() {
  const v = $('an-end-time').value; if (v) anState.endTime = v;
  anState.quick = ''; normalizeRange(); syncRangeInputs(); applyFilter();
}
function onQuick(q) {
  const maxD = anState.maxDate || todayKey();
  const minD = anState.minDate || maxD;
  let s, en;
  if (q === 'today') { s = maxD; en = maxD; }
  else if (q === 'yesterday') { en = shiftDay(maxD, -1); s = en; }
  else if (q === '3d') { en = maxD; s = shiftDay(maxD, -2); }
  // 原「全部」按钮已移除：云端归档不可用时它会退化成"本地缓存那几天"，容易被误读成系统完整历史。
  // 兜底统一收敛到"今天"，避免任何路径再产生全范围时段。
  else { s = maxD; en = maxD; }
  let clamped = false;
  if (s < minD) { s = minD; clamped = true; }
  if (en > maxD) { en = maxD; clamped = true; }
  if (s > en) s = en;
  if (clamped) toast('已调整到有数据的范围');
  anState.startDate = s; anState.endDate = en;
  anState.startTime = '00:00';
  // 结束日期是今天 → 默认到当前时刻，而非 23:59
  anState.endTime = (en === todayKey()) ? nowHM() : '23:59';
  anState.quick = q;
  syncRangeInputs();
  applyFilter();
  syncAnalysisSource();
}


// —— 分钟级分析时段：date = YYYY-MM-DD, time = HH:MM ——
function dtMs(date, time) {
  if (!date || !time) return NaN;
  const p = String(date).split('-');
  const t = String(time).split(':');
  return new Date(+p[0], +p[1] - 1, +p[2], +t[0] || 0, +t[1] || 0, 0).getTime();
}
function anStartMs() { return dtMs(anState.startDate, anState.startTime); }
function anEndMs() {
  const v = dtMs(anState.endDate, anState.endTime);
  return isNaN(v) ? v : v + 60000 - 1;    // 结束时刻所在的整分钟视为含末秒
}
function anRangeText() {
  return (anState.startDate || '--') + ' ' + (anState.startTime || '--') +
         ' 至 ' + (anState.endDate || '--') + ' ' + (anState.endTime || '--');
}
function anToken(date, time) { return (date || 'all') + '_' + String(time || 'all').replace(/:/g, '-'); }
function updateQuickUI() {
  document.querySelectorAll('.quick-row .quick').forEach(q => q.classList.toggle('quick-on', q.dataset.q === anState.quick));
}
function syncRangeInputs() {
  $('an-start').value = anState.startDate;
  $('an-start-time').value = anState.startTime;
  $('an-end').value = anState.endDate;
  $('an-end-time').value = anState.endTime;
  $('an-range').textContent = anRangeText();
  updateQuickUI();
}
function normalizeRange() {
  const sm = anStartMs(), em = anEndMs();
  if (isNaN(sm) || isNaN(em)) return;
  if (sm > em) {   // 保持 开始 <= 结束（时间维整体比较）
    if (anState.startDate !== anState.endDate) {
      const a = anState.startDate; anState.startDate = anState.endDate; anState.endDate = a;
    }
    const b = anState.startTime; anState.startTime = anState.endTime; anState.endTime = b;
  }
}

function applyFilter() {
  const sm = anStartMs(), em = anEndMs();
  if (isNaN(sm) || isNaN(em)) { records = allRecords.slice(); }
  else {
    records = allRecords.filter(r => r.unix && r.unix >= sm && r.unix <= em);
  }
  $('an-range').textContent = anRangeText();
  if (records.length === 0) {
    anState.empty = true; anState.total = 0;
    $('an-total').textContent = '0';
    $('an-span').textContent = '--'; $('an-interval').textContent = '--';
    let hint = '该分析时段内没有数据，请调整范围';
    if (anState.totalAll > 0) {
      hint += '；当前已归档 ' + anState.totalAll + ' 条，覆盖 ' + (anState.minDate || '--') + ' ~ ' + (anState.maxDate || '--');
      if (anState.minDate && anState.maxDate && (anState.endDate < anState.minDate || anState.startDate > anState.maxDate)) {
        hint += '，所选时段超出归档范围';
      } else {
        hint += '，所选时段存在数据缺口';
      }
    }
    $('an-footer').textContent = hint;
    const cov = $('an-cover-note'); if (cov) cov.textContent = anState.coverNote || '';
    drawLineChart(); drawHourly(); drawScatter(); drawCorrMatrix(); renderFourChart();
    return;
  }
  anState.empty = false;
  buildOverview(records); buildDist(records); buildCorr(records);
  buildAdvice(records); buildForecast(records); buildHourlyData(records);
  buildCorrMatrix(records); buildScatterData(records); buildReport(records);

  anState.total = records.length;
  $('an-total').textContent = records.length;
  $('an-update').textContent = anState.lastUpdate;
  $('an-footer').textContent = '农田土壤墒情云端采集与数据分析系统';

  updateStat();
  drawLineChart(); drawHourly(); drawScatter(); drawCorrMatrix(); renderFourChart();
}

function buildOverview(recs) {
  const first = recs[0].unix, last = recs[recs.length - 1].unix;
  let spanText = '--', intervalText = '--';
  if (first && last && last > first) {
    const mins = Math.round((last - first) / 60000);
    if (mins < 60) spanText = mins + ' 分钟';
    else if (mins < 1440) spanText = (mins / 60).toFixed(1) + ' 小时';
    else spanText = (mins / 1440).toFixed(1) + ' 天';
    const avgSec = (last - first) / 1000 / (recs.length - 1);
    if (avgSec < 60) intervalText = Math.round(avgSec) + ' 秒';
    else intervalText = (avgSec / 60).toFixed(1) + ' 分';
  }
  anState.spanText = spanText; anState.intervalText = intervalText;
  $('an-span').textContent = spanText; $('an-interval').textContent = intervalText;
}

function updateStat() {
  const key = anState.curKey;
  const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
  const vals = [];
  records.forEach(r => { if (r[key] !== null && r[key] !== undefined) vals.push(r[key]); });
  if (vals.length === 0) {
    anState.stat = {}; $('an-min').textContent = '--'; $('an-max').textContent = '--';
    $('an-avg').textContent = '--'; $('an-med').textContent = '--';
    $('an-std').textContent = '--'; $('an-cv').textContent = '--';
    return;
  }
  const sorted = vals.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0], max = sorted[n - 1];
  let sum = 0; for (let i = 0; i < n; i++) sum += sorted[i];
  const avg = sum / n;
  const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  let vs = 0; for (let i = 0; i < n; i++) vs += (sorted[i] - avg) * (sorted[i] - avg);
  const std = Math.sqrt(vs / n);
  const cv = avg !== 0 ? (std / Math.abs(avg)) * 100 : 0;
  anState.stat = { min, max, avg, med, std, cv, n };
  $('an-min').textContent = fmt(min, m.dec);
  $('an-max').textContent = fmt(max, m.dec);
  $('an-avg').textContent = fmt(avg, m.dec);
  $('an-med').textContent = fmt(med, m.dec);
  $('an-std').textContent = fmt(std, m.dec);
  $('an-cv').innerHTML = fmt(cv, 1) + '<span class="stat-unit">%</span>';
}

function buildDist(recs) {
  const counts = LEVELS.map(() => 0);
  let valid = 0;
  recs.forEach(r => {
    if (r.sh === null || r.sh === undefined) return;
    valid++;
    for (let i = 0; i < LEVELS.length; i++) if (r.sh >= LEVELS[i].min && r.sh < LEVELS[i].max) { counts[i]++; break; }
  });
  const dist = LEVELS.map((lv, i) => ({
    name: lv.name, count: counts[i],
    pct: valid ? Number(((counts[i] / valid) * 100).toFixed(1)) : 0, color: lv.color
  }));
  let top = dist[0];
  dist.forEach(d => { if (d.count > top.count) top = d; });
  anState.topLevel = valid ? top.name : '--'; anState.topPct = valid ? top.pct : '--';
  const box = $('an-dist');
  box.innerHTML = '';
  dist.forEach(d => {
    const row = document.createElement('div');
    row.className = 'dist-item';
    row.innerHTML = '<span class="dist-name">' + d.name + '</span>' +
      '<span class="dist-bar"><span class="dist-fill" style="width:' + d.pct + '%;background:' + d.color + ';"></span></span>' +
      '<span class="dist-pct">' + d.pct + '%</span>' +
      '<span class="dist-cnt">' + d.count + '条</span>';
    box.appendChild(row);
  });
  $('an-dist-note').textContent = '占比最高：' + anState.topLevel + '，占比 ' + anState.topPct + '%';
}

function buildCorr(recs) {
  const pair = (ka, kb) => {
    const xs = [], ys = [];
    recs.forEach(r => {
      if (r[ka] === null || r[ka] === undefined) return;
      if (r[kb] === null || r[kb] === undefined) return;
      xs.push(r[ka]); ys.push(r[kb]);
    });
    return pearson(xs, ys);
  };
  const at_sh = pair('at', 'sh'), ah_sh = pair('ah', 'sh'), st_sh = pair('st', 'sh'), at_ah = pair('at', 'ah');
  anState.corr = { at_sh: corrText(at_sh), ah_sh: corrText(ah_sh), st_sh: corrText(st_sh), at_ah: corrText(at_ah) };
  anState.corrClass = { at_sh: corrClass(at_sh), ah_sh: corrClass(ah_sh), st_sh: corrClass(st_sh), at_ah: corrClass(at_ah) };
  $('an-c-at_sh').textContent = anState.corr.at_sh; $('an-c-at_sh').className = 'corr-v ' + anState.corrClass.at_sh;
  $('an-c-ah_sh').textContent = anState.corr.ah_sh; $('an-c-ah_sh').className = 'corr-v ' + anState.corrClass.ah_sh;
  $('an-c-st_sh').textContent = anState.corr.st_sh; $('an-c-st_sh').className = 'corr-v ' + anState.corrClass.st_sh;
  $('an-c-at_ah').textContent = anState.corr.at_ah; $('an-c-at_ah').className = 'corr-v ' + anState.corrClass.at_ah;

  const items = [
    { n: '空气温度与土壤湿度', v: at_sh }, { n: '空气湿度与土壤湿度', v: ah_sh },
    { n: '土壤温度与土壤湿度', v: st_sh }, { n: '空气温度与空气湿度', v: at_ah }
  ].filter(x => x.v !== null).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  let note = '有效样本不足，无法计算相关性。';
  if (items.length) {
    const top = items[0], a = Math.abs(top.v);
    let strength = '弱相关';
    if (a >= 0.7) strength = '强相关'; else if (a >= 0.4) strength = '中等程度相关';
    const dir = top.v > 0 ? '正相关' : '负相关';
    note = top.n + '相关性最强（r=' + top.v.toFixed(3) + '，' + dir + '），呈' + strength + '。|r|≥0.7 为强相关，0.4~0.7 为中等，0.2~0.4 为弱相关。';
  }
  anState.corrNote = note; $('an-corr-note').textContent = note;
}

function buildAdvice(recs) {
  const vals = [];
  recs.forEach(r => { if (r.sh !== null && r.sh !== undefined) vals.push(r.sh); });
  if (!vals.length) { anState.adviceText = '暂无土壤湿度数据，无法给出建议。'; anState.adviceLevel = 'advice-normal'; return; }
  let sum = 0; vals.forEach(v => sum += v);
  const avg = sum / vals.length, min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  let text = '', level = 'advice-normal';
  if (avg < 30) { text = '平均土壤湿度 ' + avg.toFixed(1) + '%，处于重旱区间，建议立即启动灌溉。最低值仅 ' + min.toFixed(1) + '%，作物存在缺水风险。'; level = 'advice-danger'; }
  else if (avg < homeThr.shLow) { text = '平均土壤湿度 ' + avg.toFixed(1) + '%，处于轻旱区间，建议近期安排灌溉，优先在清晨或傍晚进行以减少蒸发损失。'; level = 'advice-warn'; }
  else if (avg < homeThr.shOpt) { text = '平均土壤湿度 ' + avg.toFixed(1) + '%，处于适宜区间（' + homeThr.shLow + '%~' + homeThr.shOpt + '%），当前无需灌溉，维持现有墒情即可。'; level = 'advice-normal'; }
  else if (avg < homeThr.shHi) { text = '平均土壤湿度 ' + avg.toFixed(1) + '%，土壤过湿，建议暂缓灌溉并加强通风，注意根系病害风险。'; level = 'advice-warn'; }
  else { text = '平均土壤湿度 ' + avg.toFixed(1) + '%，可能存在积水，建议立即排水并检查田间排水沟。'; level = 'advice-danger'; }
  text += '（区间 ' + min.toFixed(1) + '% ~ ' + max.toFixed(1) + '%，样本 ' + vals.length + ' 条）';
  anState.adviceText = text; anState.adviceLevel = level;
}

function buildForecast(recs) {
  const ys = [];
  recs.forEach(r => { if (r.sh === null || r.sh === undefined) return; ys.push(r.sh); });
  const box = $('an-forecast');

  // ARIMA(0,1,1) 单步滚动预测（端侧唯一短期预测方法，等价于指数平滑）
  const ar = arimaOneStep(ys);
  if (!ar) {
    anState.forecast = {
      arimaEnough: false,
      arimaNext: '--', arimaTheta: '--', arimaRmse: '--', arimaLo: '--', arimaHi: '--'
    };
    box.innerHTML = '<div class="fc-note">样本不足，暂无法建立趋势预测</div>';
    return;
  }
  // 95% 预测区间：±1.96·一步预测残差标准差（与论文 6.7 节口径一致）
  const half = 1.96 * ar.rmse;
  anState.forecast = {
    arimaEnough: true,
    arimaNext: ar.next.toFixed(1), arimaTheta: ar.theta.toFixed(3), arimaRmse: ar.rmse.toFixed(3),
    arimaLo: (ar.next - half).toFixed(1), arimaHi: (ar.next + half).toFixed(1)
  };
  box.innerHTML =
    '<div class="fc-sub">ARIMA(0,1,1) 单步滚动预测</div>' +
    '<div class="fc-row"><span class="fc-k">预测下一时刻土壤湿度</span><span class="fc-v">' + ar.next.toFixed(1) + '%（' + levelOf(ar.next) + '）</span></div>' +
    '<div class="fc-row"><span class="fc-k">95% 预测区间（±1.96s）</span><span class="fc-v">' + (ar.next - half).toFixed(1) + '% ~ ' + (ar.next + half).toFixed(1) + '%</span></div>' +
    '<div class="fc-row"><span class="fc-k">平滑系数 θ</span><span class="fc-v">' + ar.theta.toFixed(3) + '</span></div>' +
    '<div class="fc-row"><span class="fc-k">样本内预测 RMSE</span><span class="fc-v">' + ar.rmse.toFixed(3) + '%</span></div>';
}

function buildHourlyData(recs) {
  const buckets = [];
  for (let h = 0; h < 24; h++) buckets.push({ n: 0, sh: 0, st: 0, ah: 0, at: 0 });
  recs.forEach(r => {
    if (!r.unix) return;
    const h = new Date(r.unix).getHours();
    const b = buckets[h];
    if (r.sh !== null) { b.sh += r.sh; b.n++; }
    if (r.st !== null) b.st += r.st;
    if (r.ah !== null) b.ah += r.ah;
    if (r.at !== null) b.at += r.at;
  });
  anState.hourly = buckets.map((b, h) => ({
    hour: h, sh: b.n ? b.sh / b.n : null, st: b.n ? b.st / b.n : null,
    ah: b.n ? b.ah / b.n : null, at: b.n ? b.at / b.n : null
  }));
}

function buildCorrMatrix(recs) {
  const keys = anState.corrMatrixKeys;
  const cols = {};
  keys.forEach(k => { cols[k] = []; recs.forEach(r => { if (r[k] !== null && r[k] !== undefined) cols[k].push(r[k]); }); });
  const m = [];
  for (let i = 0; i < keys.length; i++) {
    const row = [];
    for (let j = 0; j < keys.length; j++) row.push(i === j ? 1 : pearson(cols[keys[i]], cols[keys[j]]));
    m.push(row);
  }
  anState.corrMatrix = m;
}

function buildScatterData(recs) {
  const xs = [], ys = [];
  recs.forEach(r => { if (r.ah === null || r.ah === undefined) return; if (r.sh === null || r.sh === undefined) return; xs.push(r.ah); ys.push(r.sh); });
  const fit = linregress(xs, ys);
  const box = $('an-scatter-tip');
  if (!fit || xs.length < 5) {
    anState.scatter = { enough: false };
    box.textContent = '样本不足，暂无法绘制回归';
    return;
  }
  let xmin = Infinity, xmax = -Infinity;
  xs.forEach(v => { if (v < xmin) xmin = v; if (v > xmax) xmax = v; });
  anState.scatter = {
    enough: true, r2: fit.r2.toFixed(3),
    slope: (fit.slope >= 0 ? '+' : '') + fit.slope.toFixed(3), intercept: fit.intercept.toFixed(1),
    xmin: isFinite(xmin) ? xmin : 0, xmax: isFinite(xmax) ? xmax : 100
  };
  box.innerHTML = '回归方程 y=' + anState.scatter.slope + 'x+' + anState.scatter.intercept + '　R²=' + anState.scatter.r2;
}

function buildReport(recs) {
  const lines = [];
  lines.push('一、数据概览');
  lines.push('样本 ' + recs.length + ' 条 · 跨度 ' + anState.spanText + ' · 间隔 ' + anState.intervalText);
  lines.push('');
  lines.push('二、墒情等级分布');
  lines.push('主要等级：' + anState.topLevel + '（' + anState.topPct + '%）');
  lines.push('');
  const f = anState.forecast;
  lines.push('三、趋势预测');
  if (f.arimaEnough) {
    lines.push('ARIMA(0,1,1) 单步滚动预测下一时刻 ' + f.arimaNext + '% · 95% 预测区间 ' + f.arimaLo + '% ~ ' + f.arimaHi + '%（±1.96s） · 平滑系数θ=' + f.arimaTheta + ' · 样本内RMSE=' + f.arimaRmse + '%');
  } else {
    lines.push('样本不足，暂无法建立趋势预测');
  }
  lines.push('');
  const sc = anState.scatter;
  lines.push('四、相关性（空气湿度 ~ 土壤湿度）');
  if (sc.enough) lines.push('R²=' + sc.r2 + ' · 拟合 y=' + sc.slope + 'x+' + sc.intercept);
  else lines.push('样本不足，无法计算相关');
  lines.push('');
  lines.push('五、结论与建议');
  const adv = anState.adviceText || '';
  lines.push(adv || '（暂无数据，无法给出结论与建议）');
  anState.reportLines = lines;
  const box = $('an-report');
  box.innerHTML = '';
  lines.forEach(l => { const d = document.createElement('div'); d.className = 'report-line'; d.textContent = l || ' '; box.appendChild(d); });
}

/* ---------------- 图表（canvas） ---------------- */
function setupCanvas(id) {
  const canvas = $(id);
  const dpr = window.devicePixelRatio || 2;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width || 320, H = rect.height || 240;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  return { canvas, ctx, W, H };
}

function drawTrendToCtx(ctx, W, H, key, scale) {
  const s = scale || 1;
  const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
  const padL = 40 * s, padR = 12 * s, padT = 14 * s, padB = 24 * s;
  const cw = W - padL - padR, ch = H - padT - padB;

  const pts = [];
  records.forEach(r => {
    if (r[key] === null || r[key] === undefined) return;
    pts.push({ x: r.unix, y: r[key] });
  });
  if (pts.length === 0) { ctx.fillStyle = '#a3b1bd'; ctx.font = (12 * s) + 'px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('no data', W / 2, H / 2); return; }

  let ymin = Infinity, ymax = -Infinity;
  pts.forEach(p => { if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y; });
  if (m.band) { ymin = Math.min(ymin, m.band[0]); ymax = Math.max(ymax, m.band[1]); }
  let pad = (ymax - ymin) * 0.12;
  if (!isFinite(pad) || pad <= 0) pad = Math.max(1, Math.abs(ymax) * 0.1);
  ymin -= pad; ymax += pad;
  const yspan = (ymax - ymin) || 1;

  const xMin = pts[0].x, xMax = pts[pts.length - 1].x;
  const xspan = (xMax - xMin) || 1;
  const X = t => padL + cw * (t - xMin) / xspan;
  const Y = v => padT + ch - ((v - ymin) / yspan) * ch;

  if (m.band) {
    const y1 = Y(m.band[1]), y2 = Y(m.band[0]);
    ctx.fillStyle = 'rgba(58,161,126,0.14)';
    ctx.fillRect(padL, Math.min(y1, y2), cw, Math.abs(y2 - y1));
  }
  ctx.font = (10 * s) + 'px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = ymin + (yspan * i) / 4, y = Y(v);
    ctx.strokeStyle = i === 0 ? '#c9d4de' : '#eef2f6'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
    ctx.fillStyle = '#8a9aa8'; ctx.fillText(Number(v).toFixed(m.dec), padL - 6 * s, y);
  }

  // 实时连续曲线（绘制抽稀）
  const STEP = pts.length > 1500 ? Math.ceil(pts.length / 1500) : 1;
  ctx.strokeStyle = m.color; ctx.lineWidth = 1.5 * s; ctx.lineJoin = 'round';
  ctx.beginPath();
  let first = true;
  for (let i = 0; i < pts.length; i += STEP) {
    const p = pts[i], x = X(p.x), y = Y(p.y);
    if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // ARIMA(0,1,1) 单步滚动预测：在曲线末端画虚线 + 预测点
  if (pts.length >= 5) {
    const vals = [];
    records.forEach(r => { if (typeof r[key] === 'number' && isFinite(r[key])) vals.push(r[key]); });
    const ar = arimaOneStep(vals);
    if (ar) {
      const lastP = pts[pts.length - 1], prevP = pts[pts.length - 2];
      const dt = (lastP.x - prevP.x) || (xMax - xMin) / pts.length;
      const fx = lastP.x + dt, fy = ar.next;
      // 95% 预测区间阴影带（±1.96·残差标准差），与论文 6.7 节「前端以阴影带呈现」一致。
      // 横向最小宽度 26px，避免整天视图下一个采样间隔太窄看不见。
      const half = 1.96 * ar.rmse;
      const yHi = Y(fy + half), yLo = Y(fy - half);
      const x0 = X(lastP.x), x1 = Math.max(X(fx), x0 + 26 * s);
      ctx.fillStyle = 'rgba(226,75,74,0.16)';
      ctx.fillRect(x0, Math.min(yHi, yLo), x1 - x0, Math.abs(yLo - yHi));
      // 区间上下界细线
      ctx.strokeStyle = 'rgba(226,75,74,0.45)'; ctx.lineWidth = 1 * s; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x0, yHi); ctx.lineTo(x1, yHi); ctx.moveTo(x0, yLo); ctx.lineTo(x1, yLo); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = '#e24b4a'; ctx.lineWidth = 1.5 * s; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(X(lastP.x), Y(lastP.y)); ctx.lineTo(X(fx), Y(fy)); ctx.stroke();
      ctx.setLineDash([]);
      // 竖直误差线：即使带被压得很扁也能读出区间范围
      const ex = X(fx);
      ctx.strokeStyle = '#e24b4a'; ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.moveTo(ex, yHi); ctx.lineTo(ex, yLo);
      ctx.moveTo(ex - 4 * s, yHi); ctx.lineTo(ex + 4 * s, yHi);
      ctx.moveTo(ex - 4 * s, yLo); ctx.lineTo(ex + 4 * s, yLo);
      ctx.stroke();
      ctx.fillStyle = '#e24b4a'; ctx.beginPath(); ctx.arc(ex, Y(fy), 3 * s, 0, Math.PI * 2); ctx.fill();
      ctx.font = 'bold ' + (10 * s) + 'px sans-serif'; ctx.textBaseline = 'bottom';
      const lbl = '预测 ' + fy.toFixed(m.dec) + '（95% ±' + half.toFixed(m.dec) + '）';
      if (X(fx) > padL + cw * 0.6) { ctx.textAlign = 'right'; ctx.fillText(lbl, X(fx) - 4 * s, Y(fy)); }
      else { ctx.textAlign = 'left'; ctx.fillText(lbl, X(fx) + 4 * s, Y(fy)); }
    }
  }

  // X 轴时间标签（沿时间轴均匀取 5 个刻度，显示本地 HH:MM）
  ctx.textBaseline = 'top'; ctx.fillStyle = '#8a9aa8'; ctx.font = (10 * s) + 'px sans-serif';
  const _pad2 = n => (n < 10 ? '0' : '') + n;
  const _fmtLocal = ms => {
    const d = new Date(ms);
    return _pad2(d.getHours()) + ':' + _pad2(d.getMinutes());
  };
  const TICKS = 5;
  for (let i = 0; i < TICKS; i++) {
    const t = xMin + (xspan * i) / (TICKS - 1);
    const x = X(t);
    ctx.textAlign = i === 0 ? 'left' : (i === TICKS - 1 ? 'right' : 'center');
    ctx.fillText(_fmtLocal(t), x, padT + ch + 6 * s);
  }

  // 数值标注：按分析时段总小时数 1/3 小时隔开取点（避免跨度变长/变短时密度失调）
  (function () {
    const totalH = Math.max(0.1, (xMax - xMin) / 3600000);
    const stepH = Math.max(1, Math.round(totalH / 3));
    const stepMs = stepH * 3600000;
    const labels = [];
    for (let startMs = xMin; startMs <= xMax + 1; startMs += stepMs) {
      let best = null;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const d = p.x - startMs;
        if (d < -stepMs / 2) continue;        // 还在上一个桶
        if (d > stepMs) {                       // 已越过桶右沿
          if (best) break;
          continue;
        }
        const dist = Math.abs(d);
        if (!best || dist < best.dist) best = { p: p, dist: dist };
      }
      if (!best) continue;
      // 与上一个标注过近时保留距离更近的那个
      if (labels.length && Math.abs(labels[labels.length - 1].x - best.p.x) < stepMs / 4) {
        if (best.dist < labels.length * 0 + 0) labels[labels.length - 1] = best.p; // 替换
      } else {
        labels.push(best.p);
      }
    }
    ctx.font = 'bold ' + (10 * s) + 'px sans-serif';
    ctx.fillStyle = m.color;
    ctx.textAlign = 'center';
    for (let i = 0; i < labels.length; i++) {
      const p = labels[i];
      const x = X(p.x), y = Y(p.y);
      ctx.beginPath(); ctx.fillStyle = m.color;
      ctx.arc(x, y, 2 * s, 0, Math.PI * 2); ctx.fill();
      // 默认上下交错，避免相邻标签横向重叠；贴顶/贴底时强制翻到内侧
      let below = (i % 2 === 1);
      if (y - 8 * s < padT) below = true;
      else if (y + 12 * s > padT + ch) below = false;
      ctx.textBaseline = below ? 'top' : 'bottom';
      ctx.fillText(p.y.toFixed(m.dec) + m.unit, x, below ? y + 12 * s : y - 8 * s);
    }
  })();

  // 末值徽章
  const lastP = pts[pts.length - 1];
  ctx.fillStyle = m.color; ctx.font = 'bold ' + (11 * s) + 'px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText(lastP.y.toFixed(m.dec) + m.unit, padL + cw, padT + 2 * s);
}

function drawLineChart() {
  const { ctx, W, H } = setupCanvas('lineChart');
  const key = anState.curKey;
  const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
  $('an-trend-title').textContent = m.name + ' 变化趋势';
  $('an-stat-title').textContent = '统计指标（' + m.name + ' · ' + m.unit + '）';
  $('an-trend-tip').textContent = '实时连续曲线 · 浅绿色带为适宜区间 ' + m.band[0] + ' ~ ' + m.band[1] + '　红色阴影带为 95% 预测区间　共 ' + records.length + ' 个采样点';
  drawTrendToCtx(ctx, W, H, key);
}

// 离屏渲染指定指标的变化趋势（用于 PDF 同时输出四项指标曲线）
function makeTrendCanvas(key, W, H) {
  const dpr = window.devicePixelRatio || 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  drawTrendToCtx(ctx, W, H, key);
  return cv;
}

function drawHourly() {
  const { ctx, W, H } = setupCanvas('hourlyChart');
  const data = anState.hourly.filter(b => b.sh !== null).map(b => ({ h: b.hour, v: b.sh }));
  if (data.length === 0) { ctx.fillStyle = '#a3b1bd'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('no data', W / 2, H / 2); return; }
  const padL = 30, padR = 8, padT = 10, padB = 22;
  const cw = W - padL - padR, ch = H - padT - padB;
  let ymax = 0; data.forEach(d => { if (d.v > ymax) ymax = d.v; });
  ymax = Math.max(ymax, 100);
  const Y = v => padT + ch - (v / ymax) * ch;
  ctx.fillStyle = 'rgba(58,161,126,0.12)'; ctx.fillRect(padL, Y(homeThr.shOpt), cw, Y(homeThr.shLow) - Y(homeThr.shOpt));
  const bw = cw / data.length;
  ctx.fillStyle = '#2e86ab';
  data.forEach((d, i) => { const x = padL + i * bw, h = (d.v / ymax) * ch; ctx.fillRect(x + 1, padT + ch - h, bw - 2, h); });

  ctx.font = '9px sans-serif'; ctx.fillStyle = '#8a9aa8'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 2; i++) { const v = ymax * i / 2; ctx.fillText(v.toFixed(0), padL - 4, Y(v)); }
  // x 轴：每个柱子底部标小时数（0..23），最右加"时"
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  data.forEach((d, i) => { ctx.fillText(d.h, padL + i * bw + bw / 2, padT + ch + 4); });
  ctx.fillText('时', padL + (data.length - 1) * bw + bw / 2 + 8, padT + ch + 4);
}

function drawScatter() {
  const { ctx, W, H } = setupCanvas('scatterChart');
  const pts = [];
  records.forEach(r => { if (r.ah !== null && r.sh !== null) pts.push({ x: r.ah, y: r.sh }); });
  if (pts.length === 0) { ctx.fillStyle = '#a3b1bd'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('no data', W / 2, H / 2); return; }
  const padL = 34, padR = 10, padT = 10, padB = 24;
  const cw = W - padL - padR, ch = H - padT - padB;
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  pts.forEach(p => { if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x; if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y; });
  if (xmin === xmax) { xmin -= 5; xmax += 5; }
  if (ymin === ymax) { ymin -= 5; ymax += 5; }
  const xpad = (xmax - xmin) * 0.05, ypad = (ymax - ymin) * 0.05;
  xmin -= xpad; xmax += xpad; ymin -= ypad; ymax += ypad;
  const X = v => padL + ((v - xmin) / (xmax - xmin || 1)) * cw;
  const Y = v => padT + ch - ((v - ymin) / (ymax - ymin || 1)) * ch;
  ctx.font = '9px sans-serif'; ctx.fillStyle = '#8a9aa8'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) { const v = ymin + (ymax - ymin) * i / 3, y = Y(v); ctx.strokeStyle = '#eef2f6'; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke(); ctx.fillText(v.toFixed(0), padL - 4, y); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= 3; i++) { const v = xmin + (xmax - xmin) * i / 3; ctx.fillText(v.toFixed(0), X(v), padT + ch + 4); }
  ctx.fillStyle = 'rgba(46,134,171,0.5)';
  pts.forEach(p => { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2, 0, Math.PI * 2); ctx.fill(); });
  const sc = anState.scatter;
  if (sc.enough) {
    const slope = Number(String(sc.slope).replace('+', '')), intercept = Number(sc.intercept);
    if (!isNaN(slope) && !isNaN(intercept)) {
      const y1 = slope * xmin + intercept, y2 = slope * xmax + intercept;
      ctx.strokeStyle = '#d1495b'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(X(xmin), Y(y1)); ctx.lineTo(X(xmax), Y(y2)); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  ctx.fillStyle = '#8a9aa8'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('空气湿度 %', padL + cw / 2, H - 2);
}

function drawCorrMatrix() {
  const { ctx, W, H } = setupCanvas('corrMatrixChart');
  const m = anState.corrMatrix || [], labels = anState.corrMatrixLabels || [], n = labels.length;
  const lblW = 42, lblH = 22, gx = lblW, gy = lblH;
  const gridW = W - lblW, gridH = H - lblH;
  const cw = gridW / n, ch = gridH / n;
  const empty = !m || m.length === 0;
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#45596a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let j = 0; j < n; j++) ctx.fillText(labels[j], gx + cw * (j + 0.5), gy / 2);
  ctx.textAlign = 'right';
  for (let i = 0; i < n; i++) ctx.fillText(labels[i], lblW - 5, gy + ch * (i + 0.5));
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = gx + cw * j, y = gy + ch * i;
    if (empty || m[i][j] === null || m[i][j] === undefined) { ctx.fillStyle = '#e9eef2'; ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2); continue; }
    const r = m[i][j], c = corrColor(r);
    ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
    ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
    const txt = (i === j) ? '1' : r.toFixed(2);
    const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    ctx.fillStyle = lum > 150 ? '#333333' : '#ffffff';
    ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(txt, x + cw / 2, y + ch / 2);
  }
}

function onSwitchTab(key) {
  const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
  anState.curKey = m.key; anState.curName = m.name; anState.curUnit = m.unit; anState.bandText = m.band[0] + ' ~ ' + m.band[1];
  document.querySelectorAll('#an-tabs .tab').forEach(t => t.classList.toggle('tab-on', t.dataset.key === key));
  updateStat(); drawLineChart();
  if ($('trend-modal') && !$('trend-modal').classList.contains('hidden')) openTrendZoom();
}

/* ---------------- 趋势图点击放大（电脑端弹窗） ---------------- */
function openTrendZoom() {
  const modal = $('trend-modal');
  if (!modal) return;
  const m = METRICS.filter(x => x.key === anState.curKey)[0] || METRICS[0];
  const title = $('zoom-title');
  if (title) title.textContent = m.name + ' 变化趋势（放大查看）';
  modal.classList.remove('hidden');
  const wrap = modal.querySelector('.zoom-canvas-wrap');
  const canvas = $('zoomChart');
  if (!wrap || !canvas) return;
  const dpr = window.devicePixelRatio || 2;
  const cssW = Math.max(280, Math.min(wrap.clientWidth || 600, 760));
  const cssH = Math.round(cssW * (240 / 320)); // 保持与内联图一致的宽高比
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const scale = Math.max(1, cssW / 320);
  drawTrendToCtx(ctx, cssW, cssH, anState.curKey, scale);
}
function closeTrendZoom() {
  const modal = $('trend-modal');
  if (modal) modal.classList.add('hidden');
}
function bindZoom() {
  const chart = $('lineChart');
  if (chart) chart.addEventListener('click', openTrendZoom);
  const closeBtn = $('trend-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeTrendZoom);
  const backdrop = $('trend-modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeTrendZoom);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTrendZoom(); });

  // 四指标时序图：点击放大
  const homeFour = $('homeFourChart');
  if (homeFour) homeFour.addEventListener('click', () => openChartZoom('home'));
  const four = $('fourChart');
  if (four) four.addEventListener('click', () => openChartZoom('analysis'));
  const czClose = $('chart-zoom-close');
  if (czClose) czClose.addEventListener('click', closeChartZoom);
  const czBackdrop = $('chart-zoom-backdrop');
  if (czBackdrop) czBackdrop.addEventListener('click', closeChartZoom);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeChartZoom(); });
}

/* ---------------- 四指标时序图点击放大（弹窗内重绘大图） ---------------- */
function openChartZoom(kind) {
  const modal = $('chart-zoom-modal');
  const wrap = modal && modal.querySelector('.chart-zoom-wrap');
  const canvas = $('chartZoomCanvas');
  if (!modal || !wrap || !canvas) return;

  // 取数据源：首页=今日实时；分析页=所选时段历史
  const list = kind === 'home' ? todayRecords : records;
  if (!list || list.length === 0) {
    toast('当前时序图暂无数据');
    return;
  }
  const title = kind === 'home'
    ? '今日实时四指标时序曲线（' + todayKey() + '，n=' + list.length + '）'
    : '四指标时序曲线（' + (anState.startDate || '--') + ' ' + (anState.startTime || '--') + ' — ' + (anState.endDate || '--') + ' ' + (anState.endTime || '--') + '，n=' + list.length + '）';
  const tEl = $('chart-zoom-title');
  if (tEl) tEl.textContent = title;

  // 重建数据
  const labels = [], sh = [], ah = [], st = [], at = [];
  list.forEach(r => {
    labels.push(fmtTimeLabel(new Date(r.unix)));
    sh.push(r.sh); ah.push(r.ah); st.push(r.st); at.push(r.at);
  });

  modal.classList.remove('hidden');
  if (window.chartZoomInstance) { window.chartZoomInstance.destroy(); window.chartZoomInstance = null; }
  if (typeof window.Chart === 'undefined') return;

  const ctx = canvas.getContext('2d');
  window.chartZoomInstance = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '土壤湿度 (%)', data: sh, borderColor: '#2e86ab', backgroundColor: '#2e86ab', yAxisID: 'y', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, tension: 0 },
        { label: '空气湿度 (%)', data: ah, borderColor: '#3aa17e', backgroundColor: '#3aa17e', yAxisID: 'y', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, tension: 0 },
        { label: '土壤温度 (°C)', data: st, borderColor: '#ed8b00', backgroundColor: '#ed8b00', yAxisID: 'y1', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, tension: 0 },
        { label: '空气温度 (°C)', data: at, borderColor: '#7b5ea7', backgroundColor: '#7b5ea7', yAxisID: 'y1', borderWidth: 1.8, pointRadius: 0, pointHoverRadius: 4, tension: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: title, font: { size: 15, family: "'PingFang SC','Microsoft YaHei',sans-serif" }, padding: 14 },
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, font: { size: 12 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { ticks: { maxRotation: 30, autoSkip: true, maxTicksLimit: 12, font: { size: 11 } } },
        y: { type: 'linear', position: 'left', title: { display: true, text: '湿度 (%)', font: { size: 12 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: '温度 (°C)', font: { size: 12 } }, grid: { drawOnChartArea: false } }
      }
    }
  });
}
function closeChartZoom() {
  const modal = $('chart-zoom-modal');
  if (modal) modal.classList.add('hidden');
  if (window.chartZoomInstance) { window.chartZoomInstance.destroy(); window.chartZoomInstance = null; }
}

function bindAnalysis() {
  $('an-start').addEventListener('change', onStartChange);
  $('an-end').addEventListener('change', onEndChange);
  $('an-start-time').addEventListener('change', onStartTimeChange);
  $('an-end-time').addEventListener('change', onEndTimeChange);
  document.querySelectorAll('.quick-row .quick:not(.quick-mode)').forEach(q => q.addEventListener('click', () => {
    document.querySelectorAll('.quick-row .quick:not(.quick-mode)').forEach(x => x.classList.remove('quick-on'));
    q.classList.add('quick-on'); onQuick(q.dataset.q);
  }));
  // 数据来源由所选日期自动决定：今天/未来 → 巴法云 30s；历史 → 云端数据库。
  // 模式按钮仅作状态指示，不再响应点击，避免用户手动覆盖导致日期与数据源不一致。
  if ($('mode-cloud')) $('mode-cloud').style.pointerEvents = 'none';
  if ($('mode-bemfa')) $('mode-bemfa').style.pointerEvents = 'none';
  document.querySelectorAll('#an-tabs .tab').forEach(t => t.addEventListener('click', () => onSwitchTab(t.dataset.key)));
  $('btn-an-refresh').addEventListener('click', fetchHistory);
  if ($('btn-an-clearcache')) $('btn-an-clearcache').addEventListener('click', () => {
    if (!window.confirm('确定清空本地累积的历史缓存吗？清空后只能看到云端近期数据。')) return;
    clearHist();
    allRecords = [];
    anState.cacheCount = 0; anState.cloudCount = 0;
    toast('本地缓存已清空');
    fetchHistory();
  });
  $('btn-an-xlsx').addEventListener('click', onExportXlsx);
  $('btn-an-copy').addEventListener('click', onCopy);
  $('btn-an-pdf').addEventListener('click', onExportPdf);
  $('btn-an-chart').addEventListener('click', onSaveFourChart);
}

/* ============================================================
 * 导出：复制摘要 / Excel / PDF / 四指标时序曲线图
 * ============================================================ */
function onCopy() {
  if (records.length === 0) { toast('当前时段无数据'); return; }
  const s = anState.stat;
  const lines = [
    '【农田土壤墒情数据分析摘要】',
    '主题：' + STATE.topic,
    '分析时段：' + anRangeText(),
    '样本数：' + anState.total + ' 条（缓存共 ' + anState.totalAll + ' 条）',
    '时间跨度：' + anState.spanText,
    '平均间隔：' + anState.intervalText,
    '',
    '当前指标：' + anState.curName + '（' + anState.curUnit + '）',
    '最小 ' + (s.min !== undefined ? fmt(s.min, METRICS.find(x => x.key === anState.curKey).dec) : '--') +
      ' / 最大 ' + (s.max !== undefined ? fmt(s.max, METRICS.find(x => x.key === anState.curKey).dec) : '--') +
      ' / 平均 ' + (s.avg !== undefined ? fmt(s.avg, METRICS.find(x => x.key === anState.curKey).dec) : '--'),
    '中位数 ' + (s.med !== undefined ? fmt(s.med, METRICS.find(x => x.key === anState.curKey).dec) : '--') +
      ' / 标准差 ' + (s.std !== undefined ? fmt(s.std, METRICS.find(x => x.key === anState.curKey).dec) : '--') +
      ' / 变异系数 ' + (s.cv !== undefined ? fmt(s.cv, 1) : '--') + '%',
    '',
    '墒情等级占比最高：' + anState.topLevel + ' ' + anState.topPct + '%',
    '相关性 空气温度~土壤湿度：' + anState.corr.at_sh,
    '相关性 空气湿度~土壤湿度：' + anState.corr.ah_sh,
    '',
    '趋势预测 ARIMA(0,1,1) 单步滚动：下一时刻 ' + anState.forecast.arimaNext + '% · 平滑系数θ=' + anState.forecast.arimaTheta + ' · 样本内RMSE=' + anState.forecast.arimaRmse + '%',
    '散点回归 空气~土壤 R²=' + anState.scatter.r2 + ' y=' + anState.scatter.slope + 'x+' + anState.scatter.intercept,
    '',
    anState.adviceText
  ];
  const text = lines.join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => toast('摘要已复制')).catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('摘要已复制'); } catch (e) { toast('复制失败'); }
  document.body.removeChild(ta);
}

function onExportXlsx() {
  if (!records || records.length === 0) { toast('当前时段无数据'); return; }
  const topic = STATE.topic || 'TOPIC';
  const head = ['时间', '土壤湿度(%)', '土壤温度(℃)', '空气湿度(%)', '空气温度(℃)', '墒情等级'];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('墒情数据');
  ws.columns = head.map(h => ({ header: h, width: 16 }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DDEBF7' } };
  records.forEach(r => {
    const d = new Date(r.unix || 0);
    const time = isNaN(d.getTime()) ? '' : fmtFull(d.getTime());
    // 缺测时不给等级，避免被误判成"重旱"
    const lvl = (r.sh === null || r.sh === undefined || !isFinite(r.sh)) ? '' : levelOf(r.sh);
    ws.addRow([time, r.sh, r.st, r.ah, r.at, lvl]);
  });
  ws.eachRow(row => row.eachCell(cell => { cell.alignment = { horizontal: 'center', vertical: 'middle' }; }));
  const seg = anToken(anState.startDate, anState.startTime) + '至' + anToken(anState.endDate, anState.endTime);
  const fname = '农田土壤墒情采集数据_' + topic + '_' + seg + '.xlsx';
  wb.xlsx.writeBuffer().then(buf => {
    downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fname);
    toast('xlsx 已导出（居中）');
  }).catch(e => { console.error('xlsx 导出失败', e); toast('xlsx 导出失败'); });
}

/* ---- PDF：与小程序一致，栅格化报告+图表为 JPEG 再封装最小 PDF ---- */
function formatNow() {
  const d = new Date(), p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function asciiToBytes(str) { const out = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff; return out; }
function concatBytes(arrs) { let total = 0; arrs.forEach(a => total += a.length); const out = new Uint8Array(total); let p = 0; arrs.forEach(a => { out.set(a, p); p += a.length; }); return out; }
function buildImagePdf(jpeg, w, h) {
  const chunks = [], off = []; let len = 0;
  const pushStr = s => { const b = asciiToBytes(s); chunks.push(b); len += b.length; };
  const pushBytes = b => { chunks.push(b); len += b.length; };
  const obj = s => { off.push(len); pushStr(s); };
  pushStr('%PDF-1.3\n');
  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  obj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  obj('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');
  const imgHead = '4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n';
  off.push(len); pushStr(imgHead); pushBytes(jpeg); pushStr('\nendstream\nendobj\n');
  const content = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q\n';
  obj('5 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
  const xrefOff = len;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) xref += ('0000000000' + off[i]).slice(-10) + ' 00000 n \n';
  pushStr(xref); pushStr('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF');
  return concatBytes(chunks);
}
function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function onExportPdf() {
  if (records.length === 0) { toast('当前时段无数据'); return; }
  toast('生成 PDF…');
  const W = 720;
  const pdfNode = $('pdfCanvas');
  pdfNode.width = W; pdfNode.height = 8000;
  const ctx = pdfNode.getContext('2d');
  const P = 36; let y = P;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, 8000);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';

  const wrap = (text, maxW) => {
    const lines = []; let line = ''; const str = String(text);
    for (let i = 0; i < str.length; i++) {
      const t = line + str[i];
      if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = str[i]; } else line = t;
    }
    if (line) lines.push(line);
    return lines;
  };
  const drawText = (text, font, color, leading) => { ctx.font = font; ctx.fillStyle = color; wrap(text, W - 2 * P).forEach(l => { ctx.fillText(l, P, y); y += leading; }); };
  const section = (title) => { y += 12; ctx.font = 'bold 20px sans-serif'; ctx.fillStyle = '#2e86ab'; ctx.fillText(title, P, y); y += 30; };

  ctx.fillStyle = '#233240'; ctx.font = 'bold 30px sans-serif';
  ctx.fillText('农田土壤墒情数据分析报告', P, y); y += 42;
  ctx.fillStyle = '#8a9aa8'; ctx.font = '16px sans-serif';
  ctx.fillText('分析时段：' + anRangeText() + '　生成于 ' + formatNow(), P, y); y += 30;

  section('综合分析报告');
  const rep = (anState.reportLines && anState.reportLines.length) ? anState.reportLines : ['（暂无数据）'];
  rep.forEach(l => drawText(l || ' ', '16px sans-serif', '#45596a', 26));

  section('关键统计指标');
  const s = anState.stat, m = METRICS.find(x => x.key === anState.curKey);
  drawText('当前指标：' + anState.curName + '（' + anState.curUnit + '）', '16px sans-serif', '#45596a', 26);
  drawText('最小 ' + fmt(s.min, m.dec) + ' / 最大 ' + fmt(s.max, m.dec) + ' / 平均 ' + fmt(s.avg, m.dec) + ' / 中位数 ' + fmt(s.med, m.dec), '16px sans-serif', '#45596a', 26);
  drawText('标准差 ' + fmt(s.std, m.dec) + ' / 变异系数 ' + fmt(s.cv, 1) + '%', '16px sans-serif', '#45596a', 26);
  drawText('样本 ' + anState.total + ' 条 · 跨度 ' + anState.spanText + ' · 间隔 ' + anState.intervalText, '16px sans-serif', '#45596a', 26);
  drawText('墒情占比最高：' + anState.topLevel + ' ' + anState.topPct + '%', '16px sans-serif', '#45596a', 26);

  section('墒情等级分布（按土壤湿度）');
  {
    // 复用 buildDist 同样的算法（当场重算，避免依赖 anState 里未存的 dist 数组）
    const counts = LEVELS.map(() => 0);
    let valid = 0;
    records.forEach(r => {
      if (r.sh === null || r.sh === undefined) return;
      valid++;
      for (let i = 0; i < LEVELS.length; i++) if (r.sh >= LEVELS[i].min && r.sh < LEVELS[i].max) { counts[i]++; break; }
    });
    const dist = LEVELS.map((lv, i) => ({
      name: lv.name, count: counts[i],
      pct: valid ? Number(((counts[i] / valid) * 100).toFixed(1)) : 0, color: lv.color
    }));
    let topName = '--', topPct = '--';
    if (valid) {
      let top = dist[0];
      dist.forEach(d => { if (d.count > top.count) top = d; });
      topName = top.name; topPct = top.pct;
    }
    ctx.textBaseline = 'top';
    const cwBar = W - 2 * P;
    dist.forEach(d => {
      ctx.font = '14px sans-serif';
      ctx.fillStyle = '#233240';
      ctx.textAlign = 'left';
      ctx.fillText(d.name, P, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = d.color;
      ctx.fillText(d.pct + '% · ' + d.count + ' 条', P + cwBar, y);
      y += 22;
      // 进度条（灰底 + 彩色前景）
      ctx.fillStyle = '#eef2f6';
      ctx.fillRect(P, y, cwBar, 12);
      const fillW = Math.max(0, (cwBar * d.pct) / 100);
      if (fillW > 0) { ctx.fillStyle = d.color; ctx.fillRect(P, y, fillW, 12); }
      y += 22;
    });
    y += 6;
    ctx.fillStyle = '#45596a';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('占比最高：' + topName + '（' + topPct + '%）', P, y);
    y += 30;
  }

  section('相关性分析（Pearson）');
  {
    const c = anState.corr || {}, cc = anState.corrClass || {};
    const palette = {
      'corr-strong': '#3aa17e', // 强相关 绿
      'corr-mid':    '#5fb483', // 中等相关 偏绿
      'corr-weak':   '#ed8b00', // 弱相关 橙
      'corr-none':   '#8a9aa8'  // 极弱 / 样本不足 灰
    };
    const items = [
      { k: '空气温度 ↔ 土壤湿度', v: c.at_sh, cls: cc.at_sh },
      { k: '空气湿度 ↔ 土壤湿度', v: c.ah_sh, cls: cc.ah_sh },
      { k: '土壤温度 ↔ 土壤湿度', v: c.st_sh, cls: cc.st_sh },
      { k: '空气温度 ↔ 空气湿度', v: c.at_ah, cls: cc.at_ah }
    ];
    const cwRow = W - 2 * P;
    ctx.textBaseline = 'top';
    // 表头
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#8a9aa8';
    ctx.textAlign = 'left';
    ctx.fillText('指标对', P, y);
    ctx.textAlign = 'right';
    ctx.fillText('Pearson 系数（|r|≥0.7 强 · 0.4~0.7 中 · 0.2~0.4 弱）', P + cwRow, y);
    y += 22;
    // 4 行：左指标对，右系数（按强度着色）
    items.forEach(it => {
      ctx.fillStyle = '#233240';
      ctx.textAlign = 'left';
      ctx.font = '14px sans-serif';
      ctx.fillText(it.k, P, y);
      ctx.fillStyle = palette[it.cls] || '#233240';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(it.v || '--', P + cwRow, y);
      y += 24;
    });
    y += 6;
    // 注释（按 ctx.measureText 折行）
    if (anState.corrNote) {
      const note = String(anState.corrNote);
      const maxW = W - 2 * P;
      ctx.fillStyle = '#8a9aa8';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      let line = '';
      for (let i = 0; i < note.length; i++) {
        const t = line + note[i];
        if (ctx.measureText(t).width > maxW && line) {
          ctx.fillText(line, P, y); y += 20; line = note[i];
        } else line = t;
      }
      if (line) { ctx.fillText(line, P, y); y += 24; }
    }
    y += 8;
  }

  section('图表');
  const charts = [];
  // 四项指标（土壤湿度/土壤温度/空气湿度/空气温度）变化趋势，统一输出到同一份 PDF
  METRICS.forEach(mt => {
    const cv = makeTrendCanvas(mt.key, (W - 2 * P), 200);
    if (cv && cv.width && cv.height) charts.push({ canvas: cv, w: cv.width, h: cv.height, cap: mt.name + ' 变化趋势' });
  });
  const chartDefs = [
    ['hourlyChart', '日变化规律（24h 均值）'],
    ['corrMatrixChart', '相关系数矩阵'],
    ['scatterChart', '散点回归']
  ];
  chartDefs.forEach(([id, cap]) => {
    const cv = $(id);
    if (cv && cv.width && cv.height) charts.push({ canvas: cv, w: cv.width, h: cv.height, cap });
  });
  charts.forEach((c) => {
    if (!c) return;
    y += 6; ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = '#233240'; ctx.fillText(c.cap, P, y); y += 24;
    const cw = W - 2 * P;
    const chh = Math.min(cw * (c.h / c.w), 1400);
    ctx.drawImage(c.canvas, P, y, cw, chh); y += chh + 18;
  });

  const H = Math.ceil(y + P);
  // 裁剪到内容高度
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  out.getContext('2d').drawImage(pdfNode, 0, 0, W, H, 0, 0, W, H);
  const jpegUrl = out.toDataURL('image/jpeg', 0.95);
  const jpeg = dataUrlToBytes(jpegUrl);
  const pdfBuf = buildImagePdf(jpeg, W, H);
  const topic = STATE.topic || 'TOPIC';
  const sd = anToken(anState.startDate, anState.startTime), ed = anToken(anState.endDate, anState.endTime);
  const fname = '农田土壤墒情数据分析报告_' + topic + '_' + sd + '_' + ed + '.pdf';
  downloadBlob(new Blob([pdfBuf], { type: 'application/pdf' }), fname);
  toast('PDF 已导出');
}

/* ============================================================
 * 四指标时序曲线图（土壤湿度 + 空气湿度 + 土壤温度 + 空气温度）
 * ============================================================ */
function fmtTimeLabel(d) {
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function dataUrlToBlob(dataUrl) {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) u8arr[n] = bstr.charCodeAt(n);
  return new Blob([u8arr], { type: mime });
}

function renderFourChart() {
  if (records.length === 0) {
    if (window.fourChartInstance) { window.fourChartInstance.destroy(); window.fourChartInstance = null; }
    return;
  }
  if (typeof window.Chart === 'undefined') return;

  const canvas = $('fourChart');
  if (!canvas) return;

  if (window.fourChartInstance) { window.fourChartInstance.destroy(); window.fourChartInstance = null; }

  const ctx = canvas.getContext('2d');
  const labels = [], sh = [], ah = [], st = [], at = [];
  records.forEach(r => {
    labels.push(fmtTimeLabel(new Date(r.unix)));
    sh.push(r.sh); ah.push(r.ah); st.push(r.st); at.push(r.at);
  });

  const startTxt = (anState.startDate || '--') + ' ' + (anState.startTime || '--');
  const endTxt = (anState.endDate || '--') + ' ' + (anState.endTime || '--');
  const title = '农田土壤墒情四指标时序曲线（' + startTxt + ' — ' + endTxt + '，n=' + records.length + '）';

  window.fourChartInstance = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '土壤湿度 (%)', data: sh, borderColor: '#2e86ab', backgroundColor: '#2e86ab', yAxisID: 'y', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: '空气湿度 (%)', data: ah, borderColor: '#3aa17e', backgroundColor: '#3aa17e', yAxisID: 'y', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: '土壤温度 (°C)', data: st, borderColor: '#ed8b00', backgroundColor: '#ed8b00', yAxisID: 'y1', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: '空气温度 (°C)', data: at, borderColor: '#7b5ea7', backgroundColor: '#7b5ea7', yAxisID: 'y1', borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: { display: true, text: title, font: { size: 15, family: "'PingFang SC','Microsoft YaHei',sans-serif" }, padding: 14 },
        legend: { position: 'top', align: 'end', labels: { usePointStyle: true, boxWidth: 8, font: { size: 12 } } },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: { ticks: { maxRotation: 30, autoSkip: true, maxTicksLimit: 10, font: { size: 11 } } },
        y: { type: 'linear', position: 'left', title: { display: true, text: '湿度 (%)', font: { size: 12 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y1: { type: 'linear', position: 'right', title: { display: true, text: '温度 (°C)', font: { size: 12 } }, grid: { drawOnChartArea: false } }
      }
    }
  });
}

function onSaveFourChart() {
  if (records.length === 0) { toast('当前时段无数据，无法保存'); return; }
  if (typeof window.Chart === 'undefined') { toast('图表组件未加载'); return; }
  if (!window.fourChartInstance) renderFourChart();
  if (!window.fourChartInstance) { toast('图表渲染失败'); return; }

  const url = window.fourChartInstance.toBase64Image();
  const topic = STATE.topic || 'TOPIC';
  const sd = String(anState.startDate || '00000000').replace(/-/g, '') + '_' + String(anState.startTime || '00-00').replace(/:/g, '-');
  const ed = String(anState.endDate || '00000000').replace(/-/g, '') + '_' + String(anState.endTime || '00-00').replace(/:/g, '-');
  const fname = '农田土壤墒情数据时序曲线_' + topic + '_' + sd + '_' + ed + '.png';
  downloadBlob(dataUrlToBlob(url), fname);
  toast('时序图已保存');
}
