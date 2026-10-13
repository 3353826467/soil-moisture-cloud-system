// pages/analysis/analysis.js
// Soil moisture data analysis board with date-range filter.
// Data source: Bemfa cloud history API (topic = device topic).
// Chart: native canvas 2d, no third-party dependency.
//
// API limit: getmsg "num" max is 5000. At one frame per 30s that covers
// about 41.7h (~1.7 days). The page therefore pulls the maximum once,
// caches it locally, and filters by date client-side.

const { drawTrend, arimaOneStep } = require('../../utils/trendChart.js');

const app = getApp();

// 阈值（与 ESP32 TomatoTh 对齐）：适宜上界 shOpt 可由前端远程配置，故等级分档/绿带动态读取
function loadThr() {
  try {
    const t = wx.getStorageSync('thr');
    if (t && isFinite(Number(t.shOpt))) return { shLow: Number(t.shLow), shHi: Number(t.shHi), shOpt: Number(t.shOpt) };
  } catch (e) {}
  return { shLow: 45, shHi: 80, shOpt: 65 };
}
let THR = loadThr();

const MAX_NUM = 5000;
/* 本地累积缓存：小程序单 key 上限 1MB，故按片存储 */
const HIST_PREFIX = 'bemfa_hist_';
const HIST_CHUNK = 3000;
const HIST_CHUNKS = 6;

/* ---------------- 云端历史数据源（腾讯云开发 CloudBase，可选） ----------------
 * 地址留空 = 不启用，行为与改造前一致。
 * 填了 getHistory 云函数地址后，分析页优先从云数据库读长期历史；
 * 云端不可用（未配置 / 超时 12s / 报错）时自动回退到巴法云直连 + 本地缓存。
 * 注意：小程序需在后台把云函数域名加入 request 合法域名，
 *       开发阶段可在开发者工具「详情 → 本地设置」勾选"不校验合法域名"。
 */
// 与网页端一致的默认云端历史地址（CloudBase getHistory 云函数），留空时自动启用
const DEFAULT_CLOUD_BASE = 'https://nttrsqydcjysjfxxt-d2dszi66e6a29e-1484733482.ap-shanghai.app.tcloudbase.com/getHistory';
function getCloudBase() {
  try { return (wx.getStorageSync('cloud_base') || DEFAULT_CLOUD_BASE).trim(); } catch (e) { return DEFAULT_CLOUD_BASE; }
}
function getCloudToken() {
  try { return (wx.getStorageSync('cloud_token') || '').trim(); } catch (e) { return ''; }
}

function fetchCloudHistory() {
  const base = getCloudBase();
  if (!base) return Promise.resolve(null);
  const token = getCloudToken();
  let url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'limit=5000';
  if (token) url += '&token=' + encodeURIComponent(token);
  return new Promise(function (resolve) {
    let settled = false;
    function finish(v) { if (!settled) { settled = true; resolve(v); } }
    setTimeout(function () { finish(null); }, 12000);
    wx.request({
      url: url,
      method: 'GET',
      success: function (res) {
        const j = res.data;
        if (j && j.code === 0 && Array.isArray(j.data)) {
          finish({ count: j.data.length, total: j.total || j.data.length, data: j.data });
        } else { finish(null); }
      },
      fail: function () { finish(null); }
    });
  });
}

function loadHist() {
  let out = [];
  try {
    for (let i = 0; i < HIST_CHUNKS; i++) {
      const v = wx.getStorageSync(HIST_PREFIX + i);
      if (!v || !v.length) continue;
      out = out.concat(v);
    }
  } catch (e) {}
  return out.filter(r => r && typeof r.unix === 'number' && r.unix > 0 && typeof r.sh === 'number');
}

function saveHist(list) {
  const keep = list.length > HIST_CHUNK * HIST_CHUNKS
    ? list.slice(list.length - HIST_CHUNK * HIST_CHUNKS) : list.slice();
  let i = 0;
  for (; i < Math.ceil(keep.length / HIST_CHUNK); i++) {
    try { wx.setStorageSync(HIST_PREFIX + i, keep.slice(i * HIST_CHUNK, (i + 1) * HIST_CHUNK)); }
    catch (e) { break; }
  }
  for (; i < HIST_CHUNKS; i++) { try { wx.removeStorageSync(HIST_PREFIX + i); } catch (e) {} }
  return keep.length;
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
  try { for (let i = 0; i < HIST_CHUNKS; i++) wx.removeStorageSync(HIST_PREFIX + i); } catch (e) {}
}


// metric definitions, thresholds aligned with ESP32 firmware
const METRICS = [
  { key: 'sh', name: '土壤湿度', unit: '%', band: [THR.shLow, THR.shOpt], color: '#2e86ab', dec: 0 },
  { key: 'st', name: '土壤温度', unit: '℃', band: [15, 25], color: '#d1495b', dec: 1 },
  { key: 'ah', name: '空气湿度', unit: '%', band: [50, 80], color: '#3aa17e', dec: 0 },
  { key: 'at', name: '空气温度', unit: '℃', band: [18, 28], color: '#ed8b00', dec: 1 }
];

let LEVELS = buildLevels();
function buildLevels() {
  return [
    { name: '重旱', min: -Infinity, max: 30, color: '#d1495b' },
    { name: '轻旱', min: 30, max: THR.shLow, color: '#ed8b00' },
    { name: '适宜', min: THR.shLow, max: THR.shOpt, color: '#3aa17e' },
    { name: '过湿', min: THR.shOpt, max: THR.shHi, color: '#2e86ab' },
    { name: '积水', min: THR.shHi, max: Infinity, color: '#7b5ea7' }
  ];
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function toMs(u) {
  const n = Number(u);
  if (!isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

// "2026-08-31 00:16:09" -> ms (fallback when unix is missing)
function parseTimeStr(s) {
  if (!s) return 0;
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

// local date key, YYYY-MM-DD (string compare works for range checks)
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
function pad2(n) { return (n < 10 ? '0' : '') + n; }
// 由 unix ms 转本地 HH:MM
function hhmmFromMs(ms) {
  if (!ms) return '23:59';
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

// -99 is the firmware's "sensor failed" marker
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

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let nu = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    nu += a * b; dx += a * a; dy += b * b;
  }
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

// RdYlGn continuous colormap for the correlation heatmap.
// r in [-1,1] -> red(neg) -> yellow(0) -> green(pos).
function lerpColor(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t)
  ];
}
function corrColor(r) {
  if (r === null || r === undefined) return [220, 224, 228];
  const t = (Math.max(-1, Math.min(1, r)) + 1) / 2;   // 0..1
  const red = [215, 48, 39];      // strongest negative
  const yellow = [255, 255, 191]; // ~0
  const green = [26, 152, 80];    // strongest positive
  return t < 0.5 ? lerpColor(red, yellow, t * 2) : lerpColor(yellow, green, (t - 0.5) * 2);
}

// 土壤湿度 -> 墒情等级（与 ESP32 / Python 的 judge_level 完全一致）
function levelOf(sh) {
  for (let i = 0; i < LEVELS.length; i++) {
    if (sh >= LEVELS[i].min && sh < LEVELS[i].max) return LEVELS[i].name;
  }
  return LEVELS[LEVELS.length - 1].name;
}

// 一元线性回归（对齐 Python scipy.stats.linregress）
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

// ---------- PDF export helpers (pure JS, no npm, no font embedding) ----------
// The report is rasterized onto a canvas and embedded into a single-page PDF
// as a DCTDecode (JPEG) image. Chinese text is rasterized so no CJK font needed.

function formatNow() {
  const d = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
         ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function asciiToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function concatBytes(arrs) {
  let total = 0;
  arrs.forEach(a => { total += a.length; });
  const out = new Uint8Array(total);
  let p = 0;
  arrs.forEach(a => { out.set(a, p); p += a.length; });
  return out;
}

// Build a minimal PDF wrapping one JPEG image as a full-page XObject.
// jpeg: Uint8Array, w/h: image pixel dimensions (also used as MediaBox in points).
function buildImagePdf(jpeg, w, h) {
  const chunks = [];
  let len = 0;
  const off = [];
  const pushStr = s => { const b = asciiToBytes(s); chunks.push(b); len += b.length; };
  const pushBytes = b => { chunks.push(b); len += b.length; };
  const obj = s => { off.push(len); pushStr(s); };

  pushStr('%PDF-1.3\n');
  obj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  obj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  obj('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h +
      '] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n');

  const imgHead = '4 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
                  ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
                  jpeg.length + ' >>\nstream\n';
  off.push(len); pushStr(imgHead); pushBytes(jpeg); pushStr('\nendstream\nendobj\n');

  const content = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q\n';
  obj('5 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');

  const xrefOff = len;
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) {
    xref += ('0000000000' + off[i]).slice(-10) + ' 00000 n \n';
  }
  pushStr(xref);
  pushStr('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOff + '\n%%EOF');

  return concatBytes(chunks).buffer;
}

Page({
  data: {
    metrics: METRICS,
    curKey: 'sh',
    curName: '土壤湿度',
    curUnit: '%',
    bandText: THR.shLow + ' ~ ' + THR.shOpt,

    // date filter（日期 + 时刻，可精确到分）
    startDate: '',
    endDate: '',
    startTime: '00:00',
    endTime: '23:59',
    displayRange: '--',
    minDate: '',
    maxDate: '',
    quick: '',
    coverNote: '',

    topic: '',
    total: 0,        // records in the selected range
    totalAll: 0,     // records cached from server
    points: 0,
    spanText: '--',
    intervalText: '--',
    lastUpdate: '--',
    loading: false,
    empty: false,

    stat: { min: '--', max: '--', avg: '--', med: '--', std: '--', cv: '--' },
    dist: [],
    topLevel: '--',
    topPct: '--',
    corr: { at_sh: '--', ah_sh: '--', st_sh: '--', at_ah: '--' },
    corrClass: { at_sh: '', ah_sh: '', st_sh: '', at_ah: '' },
    corrNote: '',
    adviceText: '等待数据…',
    adviceLevel: 'advice-normal',

    // ---- Python 移植模块 ----
    forecast: { arimaEnough: false, arimaNext: '--', arimaLevel: '--', arimaTheta: '--', arimaRmse: '--', arimaLo: '--', arimaHi: '--' },
    hourly: [],
    corrMatrixLabels: ['湿度', '土温', '气温', '气湿'],
    corrMatrixKeys: ['sh', 'st', 'at', 'ah'],
    corrMatrix: [],
    scatter: { enough: false, r2: '--', slope: '--', intercept: '--', xmin: 0, xmax: 100 },
    reportLines: [],
    cloudCount: 0,
    cacheCount: 0,
    fourZoom: false
  },

  allRecords: [],   // full cache from server (up to MAX_NUM)
  records: [],      // filtered by selected date range
  _lastRecordMs: 0, // 末条记录的本地 ms，供 endTime 默认值 / X 轴右端使用
  endTimeTouched: false,   // 用户手动改过结束时间：true 时系统不再自动重算 endTime

  onLoad() {
    THR = loadThr();
    LEVELS = buildLevels();
    METRICS[0].band = [THR.shLow, THR.shOpt];
    this._fetchMode = 'cloud';   // 默认值，onShow 会按所选时段重选
    this.setData({ topic: app.globalData.TOPIC || '' });
    this.renderFromCache();
  },

  onShow() {
    this.setData({ topic: app.globalData.TOPIC || '' });
    // 每次切回分析页都按当前时段确定数据源并刷新：
    // 当天数据 → 巴法云实时 + 30s 自动更新；历史数据 → 云端数据库
    // （同时重载阈值，使从其他页改过的 shLow/shOpt 立即反映到等级带与分布）
    THR = loadThr();
    LEVELS = buildLevels();
    METRICS[0].band = [THR.shLow, THR.shOpt];
    this.setData({ bandText: THR.shLow + ' ~ ' + THR.shOpt });
    this.syncAnalysisSource(true);
  },

  onHide() { this.stopAnalysisPoll(); },
  onUnload() { this.stopAnalysisPoll(); },

  onPullDownRefresh() {
    this.fetchHistory(() => wx.stopPullDownRefresh());
  },

  onRefresh() {
    this.fetchHistory();
  },

  // 「🤖 问 AI」：把本页当前时段（统计 + 抽稀采样）打包交给轻量问答页，
  // 抽稀到 60 条：既能让 AI 看清趋势，又不会把请求体撑爆。
  onAskAi() {
    const recs = this.records || [];
    if (!recs.length) {
      wx.showToast({ title: '当前时段没有数据', icon: 'none' });
      return;
    }
    const step = Math.max(1, Math.ceil(recs.length / 60));
    const slim = [];
    for (let i = 0; i < recs.length; i += step) slim.push(recs[i]);
    if (slim.length && slim[slim.length - 1] !== recs[recs.length - 1]) slim.push(recs[recs.length - 1]);

    const last = recs[recs.length - 1];
    const thr = wx.getStorageSync('thr') || {};
    let ok = true;
    try {
      wx.setStorageSync('ai_ask_ctx', {
        ctx: {
          topic: this.data.topic || '',
          latest: { sh: last.sh, st: last.st, ah: last.ah, at: last.at },
          lastUpdate: this.data.lastUpdate || '',
          rssi: null,
          thr: thr,
          an: {
            startDate: this.data.startDate, endDate: this.data.endDate,
            startTime: this.data.startTime, endTime: this.data.endTime,
            spanText: this.data.spanText, intervalText: this.data.intervalText,
            forecast: this.data.forecast, corr: this.data.corr,
            topLevel: this.data.topLevel, topPct: this.data.topPct
          },
          records: slim
        },
        question: '请解读这一时段的数据：整体水平、有无异常、未来趋势，并给出灌溉建议。',
        summary: '本页时段统计 + 抽稀采样 ' + slim.length + ' 条'
      });
    } catch (e) { ok = false; }
    if (!ok) { wx.showToast({ title: '上下文写入失败', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/aiAsk/aiAsk' });
  },

  // 点击趋势图 → 跳转横屏放大页
  onZoomTrend() {
    const key = this.data.curKey;
    const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
    const pts = [];
    this.records.forEach(r => {
      if (r[key] === null || r[key] === undefined) return;
      pts.push({ x: r.unix, y: r[key] });
    });
    if (pts.length === 0) {
      wx.showToast({ title: '当前时段无数据', icon: 'none' });
      return;
    }
    const sm = this.dtMs(this.data.startDate, this.data.startTime);
    // 经 globalData 传递，避免 URL 长度限制与大数据序列化开销
    app.globalData.__trendZoom = {
      pts: pts,
      xMin: isFinite(sm) ? sm : pts[0].x,
      xMax: pts[pts.length - 1].x,
      name: m.name,
      unit: m.unit,
      dec: m.dec,
      color: m.color,
      band: m.band
    };
    wx.navigateTo({ url: '/pages/trendZoom/trendZoom' });
  },

  onSwitch(e) {
    const key = e.currentTarget.dataset.key;
    const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
    this.setData({
      curKey: m.key,
      curName: m.name,
      curUnit: m.unit,
      bandText: m.band[0] + ' ~ ' + m.band[1]
    }, () => {
      this.updateStat();
      this.drawChart();
    });
  },

  // ---------- date range ----------
  onStartChange(e) {
    let s = e.detail.value;
    let en = this.data.endDate;
    if (s > en) en = s;
    this.setData({ startDate: s, endDate: en, quick: '' }, () => { this._commitRange(); this.syncAnalysisSource(false, true); });
  },

  onEndChange(e) {
    let en = e.detail.value;
    let s = this.data.startDate;
    if (en < s) s = en;
    const patch = { startDate: s, endDate: en, quick: '' };
    // 未手动选过结束时间 → 跟随最新数据时间
    if (!this.endTimeTouched) patch.endTime = this.latestEndTime(en);
    this.setData(patch, () => { this._commitRange(); this.syncAnalysisSource(false, true); });
  },

  // 结束时间默认值：结束日期是今天 → 取当前时刻；否则若 == 最新数据所在日 → 取最新数据时刻；再否则该日 23:59
  latestEndTime(endDate) {
    if (endDate && endDate === todayKey()) {
      const d = new Date();
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    const last = this._lastRecordMs;
    if (!last) return '23:59';
    if (endDate && endDate !== dateKey(last)) return '23:59';
    return hhmmFromMs(last);
  },

  onStartTimeChange(e) {
    this.setData({ startTime: e.detail.value, quick: '' }, () => this._commitRange());
  },

  onEndTimeChange(e) {
    this.endTimeTouched = true;   // 手动选过，之后系统不再自动改写
    this.setData({ endTime: e.detail.value, quick: '' }, () => this._commitRange());
  },

  // 刷新覆盖提示，不重置日期（供数据合并后调用）
  refreshCoverNote() {
    const recs = this.allRecords || [];
    let min = 0, max = 0;
    recs.forEach(r => { if (r.unix) { if (!min || r.unix < min) min = r.unix; if (r.unix > max) max = r.unix; } });
    const minD = min ? dateKey(min) : todayKey();
    const maxD = max ? dateKey(max) : todayKey();
    const note = '';
    this.setData({ minDate: minD, maxDate: maxD, coverNote: note });
  },

  onQuick(e) {
    const q = e.currentTarget.dataset.q;
    const maxD = this.data.maxDate || todayKey();
    const minD = this.data.minDate || maxD;
    let s, en;
    if (q === 'today') { s = maxD; en = maxD; }
    else if (q === 'yesterday') { en = shiftDay(maxD, -1); s = en; }
    else if (q === '3d') { en = maxD; s = shiftDay(maxD, -2); }
    // 原「全部」按钮已移除：云端归档不可用时它会退化成"本地缓存那几天"，容易被误读成系统完整历史。
    // 兜底统一收敛到"今天"，避免任何路径再产生全范围时段。
    else { s = maxD; en = maxD; }
    // clamp into available coverage so the picker never points at nothing
    let clamped = false;
    if (s < minD) { s = minD; clamped = true; }
    if (en > maxD) { en = maxD; clamped = true; }
    if (s > en) s = en;
    if (clamped) {
      wx.showToast({ title: '已调整到有数据的范围', icon: 'none' });
    }
    // 快捷范围：结束日期落在最新数据那一天 → 取最新数据时刻；否则 23:59
    const endT = this.latestEndTime(en);
    const startT = '00:00';
    this.endTimeTouched = false;
    this.setData({
      startDate: s, endDate: en,
      startTime: startT, endTime: endT,
      displayRange: this.rangeTextOf(s, startT, en, endT),
      quick: q
    }, () => { this.applyFilter(); this.syncAnalysisSource(false, true); });
  },


  // ---------- 分钟级时段（date=YYYY-MM-DD + time=HH:MM） ----------
  dtMs(date, time) {
    if (!date || !time) return NaN;
    const p = String(date).split('-');
    const t = String(time).split(':');
    return new Date(+p[0], +p[1] - 1, +p[2], +t[0] || 0, +t[1] || 0, 0).getTime();
  },
  rangeTextOf(sd, st, ed, et) {
    return (sd || '--') + ' ' + (st || '--') + ' 至 ' + (ed || '--') + ' ' + (et || '--');
  },
  rangeText() { return this.rangeTextOf(this.data.startDate, this.data.startTime, this.data.endDate, this.data.endTime); },
  rangeMs() {
    const sm = this.dtMs(this.data.startDate, this.data.startTime);
    let em = this.dtMs(this.data.endDate, this.data.endTime);
    em = isNaN(em) ? em : em + 60000 - 1;      // 结束时刻所在整分钟含末秒
    return { sm, em };
  },
  rangeToken(date, time) { return (date || 'all') + '_' + String(time || 'all').replace(/:/g, '-'); },
  // 统一在任意控件变化后调用：纠正 start<=end 并刷新显示、重新过滤
  _commitRange() {
    const sd = this.data.startDate, st = this.data.startTime;
    const ed = this.data.endDate, et = this.data.endTime;
    const { sm, em } = this.rangeMs();
    let nsd = sd, nst = st, ned = ed, net = et;
    if (!isNaN(sm) && !isNaN(em) && sm > em) {
      if (nsd !== ned) { const tmp = nsd; nsd = ned; ned = tmp; }
      const tmp = nst; nst = net; net = tmp;
    }
    this.setData({
      startDate: nsd, startTime: nst, endDate: ned, endTime: net,
      displayRange: this.rangeTextOf(nsd, nst, ned, net)
    }, () => this.applyFilter());
  },

  applyFilter() {
    const all = this.allRecords;
    const { sm, em } = this.rangeMs();
    let filtered;
    if (isNaN(sm) || isNaN(em)) {
      filtered = all.slice();
    } else {
      filtered = all.filter(r => r.unix && r.unix >= sm && r.unix <= em);
    }
    this.records = filtered;

    if (filtered.length === 0) {
      this.setData({
        total: 0,
        empty: true,
        spanText: '--',
        intervalText: '--',
        stat: { min: '--', max: '--', avg: '--', med: '--', std: '--', cv: '--' },
        dist: [],
        topLevel: '--',
        topPct: '--',
        corr: { at_sh: '--', ah_sh: '--', st_sh: '--', at_ah: '--' },
        corrClass: { at_sh: '', ah_sh: '', st_sh: '', at_ah: '' },
        corrNote: '所选时段内没有数据，请调整分析时段。',
        adviceText: '所选分析时段无数据，无法给出建议。',
        adviceLevel: 'advice-normal',
        points: 0,
        forecast: { arimaEnough: false, arimaNext: '--', arimaLevel: '--', arimaTheta: '--', arimaRmse: '--', arimaLo: '--', arimaHi: '--' },
        hourly: [],
        corrMatrix: [],
        scatter: { enough: false, r2: '--', slope: '--', intercept: '--', xmin: 0, xmax: 100 },
        reportLines: []
      }, () => { this.drawChart(); this.drawFourChart(); this.drawCorrMatrix(); });
      return;
    }

    this.buildOverview(filtered);
    this.buildDist(filtered);
    this.buildCorr(filtered);
    this.buildAdvice(filtered);
    this.buildForecast(filtered);
    this.buildHourly(filtered);
    this.buildCorrMatrix(filtered);
    this.buildScatter(filtered);
    this.buildReport(filtered);

    this.setData({
      total: filtered.length,
      empty: false
    }, () => {
      this.updateStat();
      this.drawChart();
      this.drawFourChart();
      this.drawHourly();
      this.drawScatter();
      this.drawCorrMatrix();
    });
  },

  // ---------- 数据源选择：当天 → 巴法云实时(30s轮询)；历史 → 云端数据库 ----------
  isLiveRange() {
    const start = this.data.startDate || '';
    const end = this.data.endDate || '';
    if (!start || !end) return true;      // 尚未确定时段，默认实时
    const t = todayKey();
    return start >= t && end >= t;        // 整个时段都在今天（含）之后才走实时
  },
  // 依据所选时段重选数据源；forceFetch=true 时强制重新拉取（如切回页面）
  // keepRange=true 时保留用户已选起止日期，仅供日期/快捷按钮切换后使用
  syncAnalysisSource(forceFetch, keepRange) {
    const want = this.isLiveRange() ? 'bemfa' : 'cloud';
    const changed = want !== (this._fetchMode || 'cloud');
    this._fetchMode = want;
    if (want === 'bemfa') this.startAnalysisPoll();
    else this.stopAnalysisPoll();
    if (changed || forceFetch) this.fetchHistory(null, keepRange);
  },

  startAnalysisPoll() {
    this.stopAnalysisPoll();
    const self = this;
    self._pollTimer = setInterval(function () {
      if (self.data.loading) return;
      self.fetchFromBemfa(null, true);   // keepRange: 轮询刷新保留用户已选时段
    }, 30000);
  },
  stopAnalysisPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  },

  // ---------- fetch + parse ----------
  fetchHistory(done, keepRange) {
    const uid = app.globalData.UID;
    const topic = app.globalData.TOPIC;
    if (!uid || !topic) {
      this.setData({ loading: false, empty: true });
      if (done) done();
      return;
    }
    this.setData({ loading: true, empty: false });

    // 当天数据 → 巴法云实时 + 30 秒自动更新；历史数据 → 云端数据库
    if (this.isLiveRange()) {
      this._fetchMode = 'bemfa';
      this.startAnalysisPoll();
      this.fetchFromBemfa(done, keepRange);
      return;
    }
    this._fetchMode = 'cloud';
    this.stopAnalysisPoll();
    fetchCloudHistory().then(cloud => {
      if (cloud && cloud.data.length) {
        const cached = loadHist();
        const merged = mergeRecs(cached, cloud.data.filter(r => r.unix > 0));
        const cacheCount = saveHist(merged);
        this.allRecords = merged;
        if (!keepRange) this.buildDateBounds(merged, 0);
        else this.refreshCoverNote();
        this.setData({
          loading: false, empty: false, totalAll: merged.length,
          cloudCount: cloud.data.length, cacheCount: cacheCount,
          lastUpdate: '云端 · ' + fmtDateClock(Date.now())
        }, () => { this.applyFilter(); if (done) done(); });
        return;
      }
      // 云端历史不可用：先回退巴法云直连（最近 5000 条 ≈ 41.7h），仍无果才落本地缓存。
      // 缺口修复：之前云端失败直接读本地缓存，导致云端欠费期间页面只剩最后一次缓存那几天。
      this.fetchFromBemfa(done, keepRange);
    });
  },

  fetchFromBemfa(done, keepRange) {
    const uid = app.globalData.UID;
    const topic = app.globalData.TOPIC;
    if (!uid || !topic) {
      this.setData({ loading: false, empty: true });
      if (done) done();
      return;
    }
    wx.request({
      url: app.globalData.API_HOST + '/va/getmsg',
      method: 'GET',
      data: { uid, topic, type: 1, num: MAX_NUM },
      success: (res) => {
        const body = res.data;
        let raw = [];
        if (body && body.code === 0 && Array.isArray(body.data)) raw = body.data;

        const recs = [];
        let noTime = 0;
        raw.forEach(it => {
          let obj = null;
          try { obj = JSON.parse(it.msg); } catch (e) { obj = null; }
          if (!obj || typeof obj !== 'object') return;
          // keep only real sensor frames
          const sh = num(obj.sh);
          if (sh === null) return;
          let ms = toMs(it.unix);
          if (!ms) ms = parseTimeStr(it.time);   // fallback to the time string
          if (!ms) noTime++;
          recs.push({
            unix: ms,
            sh: sh,
            st: num(obj.st),
            ah: num(obj.ah),
            at: num(obj.at)
          });
        });

        recs.sort((a, b) => (a.unix || 0) - (b.unix || 0));

        // 与本地累积缓存按时间戳去重合并后回写，突破云端单次 5000 条与保留期限制
        const cached = loadHist();
        const merged = mergeRecs(cached, recs.filter(r => r.unix > 0));
        const cacheCount = saveHist(merged);
        const cloudCount = recs.length;
        const all = merged.concat(recs.filter(r => !(r.unix > 0)));
        this.allRecords = all;

        if (all.length === 0) {
          this.setData({ loading: false, empty: true, total: 0, totalAll: 0 });
          if (done) done();
          return;
        }

        if (!keepRange) this.buildDateBounds(all, noTime);   // 轮询刷新时保留用户已选时段
        else this.refreshCoverNote();

        this.setData({
          loading: false,
          totalAll: all.length,
          cloudCount: cloudCount,
          cacheCount: cacheCount,
          lastUpdate: '实时(巴法云) · ' + fmtDateClock(Date.now())
        }, () => {
          this.applyFilter();
          if (done) done();
        });
      },
      fail: () => {
        if (keepRange) {   // 轮询刷新失败：保留上次数据，仅提示
          this.setData({ loading: false, lastUpdate: '刷新失败 ' + fmtDateClock(Date.now()) });
          if (done) done();
          return;
        }
        // 首次/手动拉取失败：回退到本地累积缓存
        const c = loadHist();
        if (c.length) {
          this.allRecords = c;
          this.buildDateBounds(c, 0);
          this.setData({
            loading: false, empty: false, totalAll: c.length,
            cloudCount: 0, cacheCount: c.length,
            lastUpdate: '离线 · 本地缓存 ' + fmtDateClock(Date.now())
          }, () => { this.applyFilter(); if (done) done(); });
          return;
        }
        this.setData({ loading: false, empty: true });
        wx.showToast({ title: '拉取失败', icon: 'none' });
        if (done) done();
      }
    });
  },


  // 先用本地累积缓存渲染，再联网增量更新——断网也能看历史
  renderFromCache() {
    const c = loadHist();
    if (!c.length) return false;
    this.allRecords = c;
    this.buildDateBounds(c, 0);
    this.setData({
      loading: false, empty: false, totalAll: c.length,
      cloudCount: 0, cacheCount: c.length,
      lastUpdate: '本地缓存 · ' + fmtDateClock(Date.now())
    }, () => { this.applyFilter(); });
    return true;
  },

  clearCache() {
    wx.showModal({
      title: '清空本地缓存',
      content: '将删除本机累积的历史数据，之后只能看到云端近期数据。确定继续？',
      success: (r) => {
        if (!r.confirm) return;
        clearHist();
        this.allRecords = [];
        this.setData({ cacheCount: 0, cloudCount: 0 });
        wx.showToast({ title: '已清空', icon: 'none' });
        this.fetchHistory();
      }
    });
  },

  // work out which dates the cache actually covers
  buildDateBounds(recs, noTime) {
    let min = 0, max = 0;
    recs.forEach(r => {
      if (!r.unix) return;
      if (!min || r.unix < min) min = r.unix;
      if (r.unix > max) max = r.unix;
    });

    let minD, maxD, note;
    if (!min || !max) {
      // no usable timestamps at all - fall back to today, date filter disabled
      minD = todayKey(); maxD = todayKey();
      note = '';
    } else {
      minD = dateKey(min);
      maxD = dateKey(max);
      note = '';
    }

    // 末条数据时间：作为 X 轴右端 & 结束时间默认值
    this._lastRecordMs = max;
    const isFirst = !this.data.startDate;
    const patch = { minDate: minD, maxDate: maxD, coverNote: note };
    if (isFirst) {
      // 首次进入：默认选到最新数据那一天
      patch.startDate = maxD;
      patch.endDate = maxD;
      patch.quick = (maxD === todayKey()) ? 'today' : '';
    }
    patch.startTime = this.data.startTime || '00:00';
    // 未手动选过结束时间 → 跟随最新数据时间；已有选择时仅当结束日期 == 最新日才刷新时刻
    const activeEndDate = patch.endDate || this.data.endDate || maxD;
    patch.endTime = this.endTimeTouched
      ? (this.data.endTime || this.latestEndTime(activeEndDate))
      : this.latestEndTime(activeEndDate);
    patch.displayRange = this.rangeTextOf(patch.startDate || this.data.startDate, patch.startTime, patch.endDate || this.data.endDate, patch.endTime);
    this.setData(patch);
  },

  buildOverview(recs) {
    const first = recs[0].unix;
    const last = recs[recs.length - 1].unix;
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
    this.setData({ spanText, intervalText });
  },

  updateStat() {
    const key = this.data.curKey;
    const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];
    const vals = [];
    this.records.forEach(r => { if (r[key] !== null && r[key] !== undefined) vals.push(r[key]); });

    if (vals.length === 0) {
      this.setData({ stat: { min: '--', max: '--', avg: '--', med: '--', std: '--', cv: '--' }, points: 0 });
      return;
    }

    const sorted = vals.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const min = sorted[0];
    const max = sorted[n - 1];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    const avg = sum / n;
    const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;

    let vs = 0;
    for (let i = 0; i < n; i++) vs += (sorted[i] - avg) * (sorted[i] - avg);
    const std = Math.sqrt(vs / n);
    const cv = avg !== 0 ? (std / Math.abs(avg)) * 100 : 0;

    this.setData({
      points: n,
      stat: {
        min: fmt(min, m.dec),
        max: fmt(max, m.dec),
        avg: fmt(avg, m.dec),
        med: fmt(med, m.dec),
        std: fmt(std, m.dec),
        cv: fmt(cv, 1)
      }
    });
  },

  buildDist(recs) {
    const counts = LEVELS.map(() => 0);
    let valid = 0;
    recs.forEach(r => {
      if (r.sh === null || r.sh === undefined) return;
      valid++;
      for (let i = 0; i < LEVELS.length; i++) {
        if (r.sh >= LEVELS[i].min && r.sh < LEVELS[i].max) { counts[i]++; break; }
      }
    });

    const dist = LEVELS.map((lv, i) => ({
      name: lv.name,
      count: counts[i],
      pct: valid ? Number(((counts[i] / valid) * 100).toFixed(1)) : 0,
      color: lv.color
    }));

    let top = dist[0];
    dist.forEach(d => { if (d.count > top.count) top = d; });

    this.setData({
      dist,
      topLevel: valid ? top.name : '--',
      topPct: valid ? top.pct : '--'
    });
  },

  buildCorr(recs) {
    const pair = (ka, kb) => {
      const xs = [], ys = [];
      recs.forEach(r => {
        if (r[ka] === null || r[ka] === undefined) return;
        if (r[kb] === null || r[kb] === undefined) return;
        xs.push(r[ka]); ys.push(r[kb]);
      });
      return pearson(xs, ys);
    };

    const at_sh = pair('at', 'sh');
    const ah_sh = pair('ah', 'sh');
    const st_sh = pair('st', 'sh');
    const at_ah = pair('at', 'ah');

    this.setData({
      corr: {
        at_sh: corrText(at_sh),
        ah_sh: corrText(ah_sh),
        st_sh: corrText(st_sh),
        at_ah: corrText(at_ah)
      },
      corrClass: {
        at_sh: corrClass(at_sh),
        ah_sh: corrClass(ah_sh),
        st_sh: corrClass(st_sh),
        at_ah: corrClass(at_ah)
      }
    });

    const items = [
      { n: '空气温度与土壤湿度', v: at_sh },
      { n: '空气湿度与土壤湿度', v: ah_sh },
      { n: '土壤温度与土壤湿度', v: st_sh },
      { n: '空气温度与空气湿度', v: at_ah }
    ].filter(x => x.v !== null).sort((a, b) => Math.abs(b.v) - Math.abs(a.v));

    let note = '有效样本不足，无法计算相关性。';
    if (items.length) {
      const top = items[0];
      const a = Math.abs(top.v);
      let strength = '弱相关';
      if (a >= 0.7) strength = '强相关';
      else if (a >= 0.4) strength = '中等程度相关';
      const dir = top.v > 0 ? '正相关' : '负相关';
      note = top.n + '相关性最强（r=' + top.v.toFixed(3) + '，' + dir + '），' +
             '呈' + strength + '。|r|≥0.7 为强相关，0.4~0.7 为中等，0.2~0.4 为弱相关。';
    }
    this.setData({ corrNote: note });
  },

  buildAdvice(recs) {
    const vals = [];
    recs.forEach(r => { if (r.sh !== null && r.sh !== undefined) vals.push(r.sh); });
    if (!vals.length) {
      this.setData({ adviceText: '暂无土壤湿度数据，无法给出建议。', adviceLevel: 'advice-normal' });
      return;
    }
    let sum = 0;
    vals.forEach(v => { sum += v; });
    const avg = sum / vals.length;
    const min = Math.min.apply(null, vals);
    const max = Math.max.apply(null, vals);

    let text = '', level = 'advice-normal';
    if (avg < 30) {
      text = '平均土壤湿度 ' + avg.toFixed(1) + '%，处于重旱区间，建议立即启动灌溉。最低值仅 ' + min.toFixed(1) + '%，作物存在缺水风险。';
      level = 'advice-danger';
    } else if (avg < THR.shLow) {
      text = '平均土壤湿度 ' + avg.toFixed(1) + '%，处于轻旱区间，建议近期安排灌溉，优先在清晨或傍晚进行以减少蒸发损失。';
      level = 'advice-warn';
    } else if (avg < THR.shOpt) {
      text = '平均土壤湿度 ' + avg.toFixed(1) + '%，处于适宜区间（' + THR.shLow + '%~' + THR.shOpt + '%），当前无需灌溉，维持现有墒情即可。';
      level = 'advice-normal';
    } else if (avg < THR.shHi) {
      text = '平均土壤湿度 ' + avg.toFixed(1) + '%，土壤过湿，建议暂缓灌溉并加强通风，注意根系病害风险。';
      level = 'advice-warn';
    } else {
      text = '平均土壤湿度 ' + avg.toFixed(1) + '%，可能存在积水，建议立即排水并检查田间排水沟。';
      level = 'advice-danger';
    }
    text += '（区间 ' + min.toFixed(1) + '% ~ ' + max.toFixed(1) + '%，样本 ' + vals.length + ' 条）';
    this.setData({ adviceText: text, adviceLevel: level });
  },

  // ================= Python 移植：趋势预测 =================
  // ARIMA(0,1,1) 单步滚动预测（端侧唯一短期预测方法，等价于指数平滑）
  buildForecast(recs) {
    const ys = [];
    recs.forEach(r => {
      if (r.sh === null || r.sh === undefined) return;
      ys.push(r.sh);
    });
    const ar = arimaOneStep(ys);
    if (!ar) {
      this.setData({
        forecast: {
          arimaEnough: false,
          arimaNext: '--',
          arimaLevel: '--',
          arimaTheta: '--',
          arimaRmse: '--',
          arimaLo: '--',
          arimaHi: '--'
        }
      });
      return;
    }
    // 95% 预测区间：±1.96·一步预测残差标准差（与论文 6.7 节口径一致）
    const half = 1.96 * ar.rmse;
    this.setData({
      forecast: {
        arimaEnough: true,
        arimaNext: ar.next.toFixed(1),
        arimaLevel: levelOf(ar.next),
        arimaTheta: ar.theta.toFixed(3),
        arimaRmse: ar.rmse.toFixed(3),
        arimaLo: (ar.next - half).toFixed(1),
        arimaHi: (ar.next + half).toFixed(1)
      }
    });
  },

  // ================= Python 移植：日变化规律 =================
  // 按小时聚合 4 指标均值（对齐 analyze_soil_data.daily_pattern）
  buildHourly(recs) {
    const buckets = [];
    for (let h = 0; h < 24; h++) buckets.push({ n: 0, sh: 0, st: 0, ah: 0, at: 0 });
    recs.forEach(r => {
      if (!r.unix) return;
      const h = new Date(r.unix).getHours();
      const b = buckets[h];
      if (r.sh !== null) { b.sh += r.sh; b.n++; }
      if (r.st !== null) { b.st += r.st; }
      if (r.ah !== null) { b.ah += r.ah; }
      if (r.at !== null) { b.at += r.at; }
    });
    const hourly = buckets.map((b, h) => ({
      hour: h,
      sh: b.n ? b.sh / b.n : null,
      st: b.n ? b.st / b.n : null,
      ah: b.n ? b.ah / b.n : null,
      at: b.n ? b.at / b.n : null
    }));
    this.setData({ hourly });
  },

  // ================= Python 移植：相关系数矩阵 =================
  // 4x4 Pearson 矩阵（对齐 analyze_soil_data.correlation_analysis 的矩阵）
  // 仅算数值二维数组，颜色由 drawCorrMatrix 用 RdYlGn 连续色阶渲染（替代 Python 的 imshow 热力图）
  buildCorrMatrix(recs) {
    const keys = this.data.corrMatrixKeys;   // ['sh','st','at','ah']
    const cols = {};
    keys.forEach(k => {
      cols[k] = [];
      recs.forEach(r => { if (r[k] !== null && r[k] !== undefined) cols[k].push(r[k]); });
    });
    const m = [];
    for (let i = 0; i < keys.length; i++) {
      const row = [];
      for (let j = 0; j < keys.length; j++) {
        row.push(i === j ? 1 : pearson(cols[keys[i]], cols[keys[j]]));
      }
      m.push(row);
    }
    this.setData({ corrMatrix: m });
  },

  // ================= Python 移植：散点回归 =================
  // 空气湿度 vs 土壤湿度，线性回归（对齐 analyze_soil_data.plot_correlation_scatter）
  buildScatter(recs) {
    const xs = [], ys = [];
    recs.forEach(r => {
      if (r.ah === null || r.ah === undefined) return;
      if (r.sh === null || r.sh === undefined) return;
      xs.push(r.ah); ys.push(r.sh);
    });
    const fit = linregress(xs, ys);
    if (!fit || xs.length < 5) {
      this.setData({ scatter: { enough: false, r2: '--', slope: '--', intercept: '--', xmin: 0, xmax: 100 } });
      return;
    }
    let xmin = Infinity, xmax = -Infinity;
    xs.forEach(v => { if (v < xmin) xmin = v; if (v > xmax) xmax = v; });
    this.setData({
      scatter: {
        enough: true,
        r2: fit.r2.toFixed(3),
        slope: (fit.slope >= 0 ? '+' : '') + fit.slope.toFixed(3),
        intercept: fit.intercept.toFixed(1),
        xmin: isFinite(xmin) ? xmin : 0,
        xmax: isFinite(xmax) ? xmax : 100
      }
    });
  },

  // ================= Python 移植：综合分析报告 =================
  // 汇总概览/分布/预测/相关性/建议（对齐 analyze_soil_data.generate_report）
  buildReport(recs) {
    const lines = [];
    lines.push('一、数据概览');
    lines.push('样本 ' + recs.length + ' 条 · 跨度 ' + this.data.spanText + ' · 间隔 ' + this.data.intervalText);
    lines.push('');
    lines.push('二、墒情等级分布');
    lines.push('主要等级：' + this.data.topLevel + '（' + this.data.topPct + '%）');
    lines.push('');
    const f = this.data.forecast;
    lines.push('三、趋势预测');
    if (f.arimaEnough) {
      lines.push('ARIMA(0,1,1) 单步滚动预测下一时刻 ' + f.arimaNext + '%（' + f.arimaLevel + '） · 95% 预测区间 ' + f.arimaLo + '% ~ ' + f.arimaHi + '%（±1.96s） · θ=' + f.arimaTheta + ' · 样本内RMSE=' + f.arimaRmse + '%');
    } else {
      lines.push('样本不足，暂无法建立趋势预测');
    }
    lines.push('');
    const sc = this.data.scatter;
    lines.push('四、相关性（空气湿度 ~ 土壤湿度）');
    if (sc.enough) {
      lines.push('R²=' + sc.r2 + ' · 拟合 y=' + sc.slope + 'x+' + sc.intercept);
    } else {
      lines.push('样本不足，无法计算相关');
    }
    lines.push('');
    lines.push('五、结论与建议');
    const adv = this.data.adviceText || '';
    lines.push(adv || '（暂无数据，无法给出结论与建议）');
    this.setData({ reportLines: lines });
  },

  // ---------- canvas 2d chart ----------
  // 变化趋势：按 1 小时聚合日均值（00..23 共 24 桶），跨所选时段所有同位小时求平均
  drawChart(cb) {
    const key = this.data.curKey;
    const m = METRICS.filter(x => x.key === key)[0] || METRICS[0];

    const pts = [];
    this.records.forEach(r => {
      if (r[key] === null || r[key] === undefined) return;
      pts.push({ x: r.unix, y: r[key] });
    });

    const query = wx.createSelectorQuery().in(this);
    query.select('#lineChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) { if (cb) cb(); return; }
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      let dpr = 2;
      try {
        dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) ||
              (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2;
      } catch (e) { dpr = 2; }

      const W = res[0].width || 320;
      const H = res[0].height || 200;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, W, H);

      const sm = this.dtMs(this.data.startDate, this.data.startTime);
      const xMin = isFinite(sm) ? sm : (pts.length ? pts[0].x : NaN);
      const xMax = pts.length ? pts[pts.length - 1].x : NaN;

      // 绘制逻辑统一走公共模块（横屏放大页复用同一份，避免两处漂移）
      drawTrend(ctx, W, H, {
        pts: pts,
        xMin: xMin,
        xMax: xMax,
        unit: m.unit,
        dec: m.dec,
        color: m.color,
        band: m.band,
        scale: 1
      });

      if (cb) cb();
    });
  },

  // ================= Python 移植：日变化柱状图 =================
  drawHourly() {
    const hourly = this.data.hourly;
    const data = hourly.filter(b => b.sh !== null).map(b => ({ h: b.hour, v: b.sh }));
    const query = wx.createSelectorQuery().in(this);
    query.select('#hourlyChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      let dpr = 2;
      try { dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2; } catch (e) { dpr = 2; }
      const W = res[0].width || 320, H = res[0].height || 240;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

      if (data.length === 0) {
        ctx.fillStyle = '#a3b1bd'; ctx.font = '12px sans-serif';
        ctx.textAlign = 'center'; ctx.fillText('no data', W / 2, H / 2);
        return;
      }
      const padL = 30, padR = 8, padT = 10, padB = 22;
      const cw = W - padL - padR, ch = H - padT - padB;
      let ymax = 0;
      data.forEach(d => { if (d.v > ymax) ymax = d.v; });
      ymax = Math.max(ymax, 100);
      const Y = v => padT + ch - (v / ymax) * ch;

      // suitable band (shLow~shOpt)
      ctx.fillStyle = 'rgba(58,161,126,0.12)';
      ctx.fillRect(padL, Y(THR.shOpt), cw, Y(THR.shLow) - Y(THR.shOpt));

      const bw = cw / data.length;
      ctx.fillStyle = '#2e86ab';
      data.forEach((d, i) => {
        const x = padL + i * bw;
        const h = (d.v / ymax) * ch;
        ctx.fillRect(x + 1, padT + ch - h, bw - 2, h);
      });

      // x labels（每个柱子底部只标小时数：0 1 2 … 23；最右加"时"）
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#8a9aa8';
      data.forEach((d, i) => {
        ctx.fillText(d.h, padL + i * bw + bw / 2, padT + ch + 6);
      });
      // 最右追加"时"
      const _lastI = data.length - 1;
      ctx.fillText('时', padL + _lastI * bw + bw / 2 + 8, padT + ch + 6);

      // y labels
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const v = (ymax * i) / 4;
        const y = Y(v);
        ctx.strokeStyle = i === 0 ? '#c9d4de' : '#eef2f6';
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
        ctx.fillStyle = '#8a9aa8';
        ctx.fillText(v.toFixed(0), padL - 4, y);
      }
    });
  },


  // ================= Python 移植：相关系数矩阵热力图（连续渐变） =================
  drawCorrMatrix() {
    const m = this.data.corrMatrix || [];
    const labels = this.data.corrMatrixLabels || [];
    const n = labels.length;   // 4
    const query = wx.createSelectorQuery().in(this);
    query.select('#corrMatrixChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      let dpr = 2;
      try { dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2; } catch (e) { dpr = 2; }
      const W = res[0].width || 320, H = res[0].height || 320;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

      const lblW = 42, lblH = 22;     // reserved space for axis labels
      const gx = lblW, gy = lblH;
      const gridW = W - lblW, gridH = H - lblH;
      const cw = gridW / n, ch = gridH / n;
      const empty = !m || m.length === 0;

      // axis labels
      ctx.font = '11px sans-serif';
      ctx.fillStyle = '#45596a';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let j = 0; j < n; j++) ctx.fillText(labels[j], gx + cw * (j + 0.5), gy / 2);
      ctx.textAlign = 'right';
      for (let i = 0; i < n; i++) ctx.fillText(labels[i], lblW - 5, gy + ch * (i + 0.5));

      // cells
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const x = gx + cw * j, y = gy + ch * i;
          if (empty || m[i][j] === null || m[i][j] === undefined) {
            ctx.fillStyle = '#e9eef2';
            ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
            continue;
          }
          const r = m[i][j];
          const c = corrColor(r);
          ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
          ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
          const txt = (i === j) ? '1' : r.toFixed(2);
          const lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
          ctx.fillStyle = lum > 150 ? '#333333' : '#ffffff';
          ctx.font = 'bold 12px sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(txt, x + cw / 2, y + ch / 2);
        }
      }
    });
  },

  // ================= 散点回归（空气湿度 vs 土壤湿度） =================
  // 历史原因：函数体曾缺失，导致 applyFilter 调用时抛错、连带 drawCorrMatrix 也不执行
  // 对齐 web_app/app.js 的 drawScatter：散点 + 一元线性回归拟合线
  drawScatter() {
    const sc = this.data.scatter;
    const pts = [];
    this.records.forEach(r => {
      if (r.ah === null || r.ah === undefined) return;
      if (r.sh === null || r.sh === undefined) return;
      pts.push({ x: r.ah, y: r.sh });
    });

    const query = wx.createSelectorQuery().in(this);
    query.select('#scatterChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      let dpr = 2;
      try { dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2; } catch (e) { dpr = 2; }
      const W = res[0].width || 320, H = res[0].height || 320;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

      if (pts.length === 0) {
        ctx.fillStyle = '#a3b1bd'; ctx.font = '12px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('no data', W / 2, H / 2);
        return;
      }

      const padL = 34, padR = 10, padT = 10, padB = 24;
      const cw = W - padL - padR, ch = H - padT - padB;
      let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      pts.forEach(p => {
        if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
        if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
      });
      if (xmin === xmax) { xmin -= 5; xmax += 5; }
      if (ymin === ymax) { ymin -= 5; ymax += 5; }
      const xpad = (xmax - xmin) * 0.05, ypad = (ymax - ymin) * 0.05;
      xmin -= xpad; xmax += xpad; ymin -= ypad; ymax += ypad;
      const X = v => padL + ((v - xmin) / (xmax - xmin || 1)) * cw;
      const Y = v => padT + ch - ((v - ymin) / (ymax - ymin || 1)) * ch;

      // 网格 + 刻度
      ctx.font = '9px sans-serif'; ctx.fillStyle = '#8a9aa8';
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 3; i++) {
        const v = ymin + (ymax - ymin) * i / 3, y = Y(v);
        ctx.strokeStyle = '#eef2f6'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
        ctx.fillText(v.toFixed(0), padL - 4, y);
      }
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let i = 0; i <= 3; i++) {
        const v = xmin + (xmax - xmin) * i / 3;
        ctx.fillText(v.toFixed(0), X(v), padT + ch + 4);
      }

      // 散点
      ctx.fillStyle = 'rgba(46,134,171,0.5)';
      pts.forEach(p => { ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 2, 0, Math.PI * 2); ctx.fill(); });

      // 回归拟合线
      if (sc && sc.enough) {
        const slope = Number(String(sc.slope).replace('+', ''));
        const intercept = Number(sc.intercept);
        if (!isNaN(slope) && !isNaN(intercept)) {
          const y1 = slope * xmin + intercept, y2 = slope * xmax + intercept;
          ctx.strokeStyle = '#d1495b'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
          ctx.beginPath(); ctx.moveTo(X(xmin), Y(y1)); ctx.lineTo(X(xmax), Y(y2)); ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // 坐标轴标题
      ctx.fillStyle = '#8a9aa8'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText('空气湿度 %', padL + cw / 2, H - 2);
    });
  },

  // ================= 四指标时序曲线（对齐 web_app 的 renderFourChart） =================
  // 土壤湿度/空气湿度走左轴(%)，土壤温度/空气温度走右轴(℃)，同源时间轴
  drawFourChart() {
    const recs = this.records || [];
    const self = this;
    const query = wx.createSelectorQuery().in(this);
    query.select('#fourChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      self._fourNode = res[0].node;
      self._drawFourChartCore(res[0].node, res[0].width || 320, res[0].height || 220, recs);
    });
  },

  // 核心绘制：在指定 canvas 上画四指标时序曲线（首页/放大横屏复用）
  _drawFourChartCore(canvas, W, H, recs) {
    const ctx = canvas.getContext('2d');
    let dpr = 2;
    try { dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2; } catch (e) { dpr = 2; }
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, W, H);

    if (!recs || recs.length === 0) {
      ctx.fillStyle = '#a3b1bd'; ctx.font = '13px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('no data', W / 2, H / 2);
      return;
    }

    const series = [
      { key: 'sh', color: '#2e86ab', axis: 'L', name: '土壤湿度' },
      { key: 'ah', color: '#3aa17e', axis: 'L', name: '空气湿度' },
      { key: 'st', color: '#ed8b00', axis: 'R', name: '土壤温度' },
      { key: 'at', color: '#7b5ea7', axis: 'R', name: '空气温度' }
    ];

    const minMs = recs[0].unix, maxMs = recs[recs.length - 1].unix;
      let rMin = Infinity, rMax = -Infinity;
      recs.forEach(r => {
        ['st', 'at'].forEach(k => {
          const v = r[k];
          if (v !== null && v !== undefined) { if (v < rMin) rMin = v; if (v > rMax) rMax = v; }
        });
      });
      if (!isFinite(rMin)) { rMin = 0; rMax = 40; }
      const rPad = (rMax - rMin) * 0.1 || 2;
      rMin -= rPad; rMax += rPad;

      const padL = 38, padR = 40, padT = 34, padB = 26;
      const cw = W - padL - padR, ch = H - padT - padB;
      const X = ms => padL + ((maxMs === minMs) ? 0.5 : (ms - minMs) / (maxMs - minMs)) * cw;
      const YL = v => padT + ch - (v / 100) * ch;
      const YR = v => padT + ch - ((v - rMin) / (rMax - rMin || 1)) * ch;

      // 左轴网格（0..100）与刻度
      ctx.font = '9px sans-serif'; ctx.textBaseline = 'middle';
      for (let i = 0; i <= 4; i++) {
        const v = (100 * i) / 4;
        const y = YL(v);
        ctx.strokeStyle = i === 0 ? '#c9d4de' : '#eef2f6';
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
        ctx.fillStyle = '#8a9aa8'; ctx.textAlign = 'right';
        ctx.fillText(v.toFixed(0), padL - 4, y);
      }
      // 右轴刻度（温度）
      ctx.textAlign = 'left';
      for (let i = 0; i <= 4; i++) {
        const v = rMin + (rMax - rMin) * i / 4;
        const y = YR(v);
        ctx.fillStyle = '#8a9aa8';
        ctx.fillText(v.toFixed(1), padL + cw + 4, y);
      }
      // X 轴时间刻度（最多 6 个）
      const nt = Math.min(6, recs.length);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      for (let i = 0; i < nt; i++) {
        const idx = Math.round(i * (recs.length - 1) / (nt - 1 || 1));
        const r = recs[idx];
        const x = X(r.unix);
        const d = new Date(r.unix);
        ctx.fillStyle = '#8a9aa8';
        ctx.fillText(pad2(d.getHours()) + ':' + pad2(d.getMinutes()), x, padT + ch + 6);
      }

      // 四条曲线
      series.forEach(s => {
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.6; ctx.beginPath();
        let started = false;
        recs.forEach(r => {
          const v = r[s.key];
          if (v === null || v === undefined) return;
          const x = X(r.unix);
          const y = s.axis === 'L' ? YL(v) : YR(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });

      // 图例（顶部）
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      const lgY = 14;
      const colW = (W - 8) / series.length;
      series.forEach((s, i) => {
        const lx = 4 + i * colW;
        ctx.fillStyle = s.color;
        ctx.fillRect(lx, lgY - 4, 10, 8);
        ctx.fillStyle = '#45596a'; ctx.font = '10px sans-serif';
        ctx.fillText(s.name, lx + 13, lgY);
      });
  },

  // 点击时序图 → 全屏横屏放大查看
  onFourChartTap() {
    const recs = this.records || [];
    if (!recs.length) { wx.showToast({ title: '当前时段无数据', icon: 'none' }); return; }
    this.setData({ fourZoom: true });
    try { wx.setPageOrientation({ orientation: 'landscape' }); } catch (e) {}
    const self = this;
    setTimeout(() => self._drawFourZoom(), 380);
  },
  _drawFourZoom() {
    const recs = this.records || [];
    const self = this;
    const query = wx.createSelectorQuery().in(this);
    query.select('#fourChartZoom').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      self._drawFourChartCore(res[0].node, res[0].width || 400, res[0].height || 300, recs);
    });
  },
  onCloseFourZoom() {
    this.setData({ fourZoom: false });
    try { wx.setPageOrientation({ orientation: 'portrait' }); } catch (e) {}
    const self = this;
    setTimeout(() => { if (self.records) self.drawFourChart(); }, 380);
  },

  // 把四指标时序图保存到相册（相册不可用则退化为打开图片）
  onSaveFourChart() {
    if (!this.records || this.records.length === 0) {
      wx.showToast({ title: '当前时段无数据', icon: 'none' });
      return;
    }
    if (!this._fourNode) {
      wx.showToast({ title: '图表未就绪', icon: 'none' });
      return;
    }
    const self = this;
    wx.showLoading({ title: '保存中...', mask: true });
    wx.canvasToTempFilePath({
      canvas: self._fourNode,
      success: (res) => {
        const temp = res.tempFilePath;
        const fs = wx.getFileSystemManager();
        const topic = self.data.topic || 'TOPIC';
        const sd = self.rangeToken(self.data.startDate, self.data.startTime).replace(/_/g, '');
        const ed = self.rangeToken(self.data.endDate, self.data.endTime).replace(/_/g, '');
        const fname = '农田土壤墒情数据时序曲线_' + topic + '_' + sd + '_' + ed + '.png';
        const fpath = wx.env.USER_DATA_PATH + '/' + fname;
        try { fs.writeFileSync(fpath, fs.readFileSync(temp)); }
        catch (e) { wx.hideLoading(); wx.showToast({ title: '保存失败', icon: 'none' }); return; }
        wx.saveImageToPhotosAlbum({
          filePath: fpath,
          success: () => { wx.hideLoading(); wx.showToast({ title: '已保存到相册', icon: 'success' }); },
          fail: () => {
            wx.hideLoading();
            wx.openDocument({
              filePath: fpath, fileType: 'image', showMenu: true,
              fail: () => wx.showModal({ title: '保存完成', content: '时序图已生成：' + fname + '\n' + fpath, showCancel: false })
            });
          }
        });
      },
      fail: () => { wx.hideLoading(); wx.showToast({ title: '截图失败', icon: 'none' }); }
    });
  },

  // ---------- copy summary ----------
  onCopy() {
    const s = this.data.stat;
    const lines = [
      '【农田土壤墒情数据分析摘要】',
      '主题：' + this.data.topic,
      '分析时段：' + (this.data.displayRange || this.rangeText()),
      '样本数：' + this.data.total + ' 条（缓存共 ' + this.data.totalAll + ' 条）',
      '时间跨度：' + this.data.spanText,
      '平均间隔：' + this.data.intervalText,
      '',
      '当前指标：' + this.data.curName + '（' + this.data.curUnit + '）',
      '最小 ' + s.min + ' / 最大 ' + s.max + ' / 平均 ' + s.avg,
      '中位数 ' + s.med + ' / 标准差 ' + s.std + ' / 变异系数 ' + s.cv + '%',
      '',
      '墒情等级占比最高：' + this.data.topLevel + ' ' + this.data.topPct + '%',
      '相关性 空气温度~土壤湿度：' + this.data.corr.at_sh,
      '相关性 空气湿度~土壤湿度：' + this.data.corr.ah_sh,
      '',
      '趋势预测 ARIMA(0,1,1) 单步滚动：下一时刻 ' + this.data.forecast.arimaNext + '%（' + this.data.forecast.arimaLevel + '） · θ=' + this.data.forecast.arimaTheta + ' · 样本内RMSE=' + this.data.forecast.arimaRmse,
      '趋势预测 ARIMA(0,1,1)：' + this.data.forecast.arimaNext + '%（' + this.data.forecast.arimaLevel + '） θ=' + this.data.forecast.arimaTheta + ' RMSE=' + this.data.forecast.arimaRmse,
      '散点回归 空气~土壤 R²=' + this.data.scatter.r2 + ' y=' + this.data.scatter.slope + 'x+' + this.data.scatter.intercept,
      '',
      this.data.adviceText
    ];
    wx.setClipboardData({
      data: lines.join('\n'),
      success: () => wx.showToast({ title: '摘要已复制', icon: 'success' })
    });
  },

  // ---------- export (XLSX with CSV fallback) ----------
  // 优先 ExcelJS 写出带居中样式的 xlsx；不可用时降级为 UTF-8 BOM CSV，文件名带分析时段
  onExportExcel() {
    if (!this.records || this.records.length === 0) {
      wx.showToast({ title: '当前时段无数据', icon: 'none' });
      return;
    }
    const recs = this.records;
    const topic = this.data.topic || 'TOPIC';
    const head = ['时间', '土壤湿度(%)', '土壤温度(℃)', '空气湿度(%)', '空气温度(℃)', '墒情等级'];
    const fmtTime = r => {
      const d = new Date(r.unix || 0);
      if (isNaN(d.getTime())) return '';
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
             pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    };
    // 缺测时不给等级，避免被误判成"重旱"
    const lvlOf = r => (r.sh === null || r.sh === undefined || !isFinite(r.sh)) ? '' : levelOf(r.sh);
    const seg = this.rangeToken(this.data.startDate, this.data.startTime) + '至' + this.rangeToken(this.data.endDate, this.data.endTime);
    const fname = '农田土壤墒情采集数据_' + topic + '_' + seg + '.xlsx';
    const fs = wx.getFileSystemManager();
    const fpath = wx.env.USER_DATA_PATH + '/' + fname;
    // 优先 ExcelJS 导出居中 xlsx；小程序端若 ExcelJS 不可用则降级 CSV
    let ExcelJS = null;
    try { if (typeof self === 'undefined') global.self = global; ExcelJS = require('../../exceljs.min.js'); } catch (e) { ExcelJS = null; }
    if (ExcelJS && ExcelJS.Workbook) {
      try {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('墒情数据');
        ws.columns = head.map(h => ({ header: h, width: 16 }));
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'DDEBF7' } };
        recs.forEach(r => ws.addRow([fmtTime(r), r.sh, r.st, r.ah, r.at, lvlOf(r)]));
        ws.eachRow(row => row.eachCell(cell => { cell.alignment = { horizontal: 'center', vertical: 'middle' }; }));
        wb.xlsx.writeBuffer().then(buf => {
          try { fs.writeFileSync(fpath, buf); } catch (e) { wx.showToast({ title: '写入失败: ' + (e.message || e), icon: 'none' }); return; }
          wx.openDocument({
            filePath: fpath, fileType: 'xlsx', showMenu: true,
            success: () => {},
            fail: () => { wx.showModal({ title: '导出完成', content: 'xlsx 已生成：' + fname + '\n路径：' + fpath, showCancel: false }); }
          });
        }).catch(e => { wx.showToast({ title: 'xlsx 生成失败: ' + (e.message || e), icon: 'none' }); });
        return;
      } catch (e) { /* 落到 CSV 降级 */ }
    }
    // 降级：CSV（文件名带分析时段，但不含居中样式）
    const cell = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [head.join(',')];
    recs.forEach(r => { lines.push([cell(fmtTime(r)), cell(r.sh), cell(r.st), cell(r.ah), cell(r.at), cell(lvlOf(r))].join(',')); });
    const csv = '\ufeff' + lines.join('\r\n');
    const csvFname = fname.replace(/\.xlsx$/, '.csv');
    const csvPath = wx.env.USER_DATA_PATH + '/' + csvFname;
    try { fs.writeFileSync(csvPath, csv, 'utf8'); } catch (e) { wx.showToast({ title: '写入失败: ' + (e.message || e), icon: 'none' }); return; }
    wx.openDocument({
      filePath: csvPath, fileType: 'csv', showMenu: true,
      success: () => {},
      fail: () => { wx.showModal({ title: '已导出（CSV 降级）', content: 'xlsx 居中需 ExcelJS；当前已降级 CSV：' + csvFname + '\n' + csvPath, showCancel: false }); }
    });
  },

  // Snapshot a live chart canvas onto a white-background offscreen canvas so the
  // embedded picture keeps a clean white background (no transparent->black in JPEG).
  getChartImage(id) {
    return new Promise((resolve) => {
      wx.createSelectorQuery().in(this).select('#' + id).fields({ node: true }).exec((res) => {
        const node = res && res[0] && res[0].node;
        if (!node || !node.width || !node.height) { resolve(null); return; }
        const w = node.width, h = node.height;
        let off = null;
        try { off = wx.createOffscreenCanvas({ type: '2d', width: w, height: h }); } catch (e) { off = null; }
        if (!off) { resolve(null); return; }
        const octx = off.getContext('2d');
        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, w, h);
        octx.drawImage(node, 0, 0, w, h);
        resolve({ canvas: off, w, h });
      });
    });
  },

  onExportPdf() {
    wx.showLoading({ title: '生成 PDF...', mask: true });
    this._exportPdfCore()
      .then(() => wx.hideLoading())
      .catch((e) => {
        wx.hideLoading();
        wx.showModal({
          title: '导出失败',
          content: String((e && e.message) ? e.message : e),
          showCancel: false
        });
      });
  },

  async _exportPdfCore() {
    const fs = wx.getFileSystemManager();
    const W = 720;            // logical canvas width (also PDF page width in points)

    // 1. 渲染四项指标（土壤湿度/土壤温度/空气湿度/空气温度）变化趋势 + 其余图表，统一进同一份 PDF
    const charts = [];
    const origKey = this.data.curKey;
    const origM = METRICS.filter(x => x.key === origKey)[0] || METRICS[0];
    for (const mt of METRICS) {
      await new Promise((resolve) => {
        this.setData({ curKey: mt.key, curName: mt.name, curUnit: mt.unit, bandText: mt.band[0] + ' ~ ' + mt.band[1] }, () => {
          this.drawChart(() => resolve());
        });
      });
      const ci = await this.getChartImage('lineChart');
      charts.push(ci ? { canvas: ci.canvas, w: ci.w, h: ci.h, cap: mt.name + ' 变化趋势' } : null);
    }
    // 还原屏幕上当前选中的指标曲线
    await new Promise((resolve) => {
      this.setData({ curKey: origM.key, curName: origM.name, curUnit: origM.unit, bandText: origM.band[0] + ' ~ ' + origM.band[1] }, () => {
        this.drawChart(() => resolve());
      });
    });
    const chartDefs = [
      ['hourlyChart', '日变化规律（24h 均值）'],
      ['corrMatrixChart', '相关系数矩阵'],
      ['scatterChart', '散点回归']
    ];
    for (let i = 0; i < chartDefs.length; i++) {
      const ci = await this.getChartImage(chartDefs[i][0]);
      charts.push(ci ? { canvas: ci.canvas, w: ci.w, h: ci.h, cap: chartDefs[i][1] } : null);
    }

    // 2. build the report canvas
    const pdfNode = await new Promise((resolve) => {
      wx.createSelectorQuery().in(this).select('#pdfCanvas').fields({ node: true }).exec((r) => {
        resolve(r && r[0] ? r[0].node : null);
      });
    });
    if (!pdfNode) throw new Error('找不到 pdfCanvas 节点');

    pdfNode.width = W;
    pdfNode.height = 8000;
    const ctx = pdfNode.getContext('2d');
    const P = 36;
    let y = P;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, 8000);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    const wrap = (text, maxW) => {
      const lines = [];
      let line = '';
      const str = String(text);
      for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const t = line + ch;
        if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = ch; }
        else line = t;
      }
      if (line) lines.push(line);
      return lines;
    };
    const drawText = (text, font, color, leading) => {
      ctx.font = font; ctx.fillStyle = color;
      wrap(text, W - 2 * P).forEach((l) => { ctx.fillText(l, P, y); y += leading; });
    };
    const section = (title) => {
      y += 12;
      ctx.font = 'bold 20px sans-serif'; ctx.fillStyle = '#2e86ab';
      ctx.fillText(title, P, y);
      y += 30;
    };

    // title + meta
    ctx.fillStyle = '#233240';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillText('农田土壤墒情数据分析报告', P, y);
    y += 42;
    ctx.fillStyle = '#8a9aa8';
    ctx.font = '16px sans-serif';
    ctx.fillText('分析时段：' + (this.data.displayRange || this.rangeText()) +
                 '　生成于 ' + formatNow(), P, y);
    y += 30;

    // integrated report
    section('综合分析报告');
    const rep = (this.data.reportLines && this.data.reportLines.length) ? this.data.reportLines : ['（暂无数据）'];
    rep.forEach((l) => drawText(l || ' ', '16px sans-serif', '#45596a', 26));

    // key stats
    section('关键统计指标');
    const s = this.data.stat;
    drawText('当前指标：' + this.data.curName + '（' + this.data.curUnit + '）', '16px sans-serif', '#45596a', 26);
    drawText('最小 ' + s.min + ' / 最大 ' + s.max + ' / 平均 ' + s.avg + ' / 中位数 ' + s.med, '16px sans-serif', '#45596a', 26);
    drawText('标准差 ' + s.std + ' / 变异系数 ' + s.cv + '%', '16px sans-serif', '#45596a', 26);
    drawText('样本 ' + this.data.total + ' 条 · 跨度 ' + this.data.spanText + ' · 间隔 ' + this.data.intervalText, '16px sans-serif', '#45596a', 26);
    drawText('墒情占比最高：' + this.data.topLevel + ' ' + this.data.topPct + '%', '16px sans-serif', '#45596a', 26);

    // 墒情等级分布（按土壤湿度）
    section('墒情等级分布（按土壤湿度）');
    {
      const dist = this.data.dist || [];
      const cwBar = W - 2 * P;
      dist.forEach((d) => {
        ctx.font = '14px sans-serif';
        ctx.fillStyle = '#233240';
        ctx.textAlign = 'left';
        ctx.fillText(d.name, P, y);
        ctx.textAlign = 'right';
        ctx.fillStyle = d.color;
        ctx.fillText((d.pct || 0) + '% · ' + (d.count || 0) + ' 条', P + cwBar, y);
        y += 22;
        // 进度条（灰底 + 彩色前景）
        ctx.fillStyle = '#eef2f6';
        ctx.fillRect(P, y, cwBar, 12);
        const fillW = Math.max(0, (cwBar * (d.pct || 0)) / 100);
        if (fillW > 0) { ctx.fillStyle = d.color; ctx.fillRect(P, y, fillW, 12); }
        y += 22;
      });
      y += 6;
      ctx.fillStyle = '#45596a';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText('占比最高：' + this.data.topLevel + '（' + this.data.topPct + '%）', P, y);
      y += 30;
    }

    // 相关性分析（Pearson）
    section('相关性分析（Pearson）');
    {
      const palette = {
        'corr-strong': '#3aa17e', // 强相关 绿
        'corr-mid':    '#5fb483', // 中等相关 偏绿
        'corr-weak':   '#ed8b00', // 弱相关 橙
        'corr-none':   '#8a9aa8'  // 极弱 / 样本不足 灰
      };
      const c = this.data.corr || {}, cc = this.data.corrClass || {};
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
      items.forEach((it) => {
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
      // 注释（按 wrap 折行）
      if (this.data.corrNote) {
        ctx.fillStyle = '#8a9aa8';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'left';
        wrap(this.data.corrNote, W - 2 * P).forEach((l) => { ctx.fillText(l, P, y); y += 20; });
      }
      y += 8;
    }

    // charts
    section('图表');
    for (let i = 0; i < charts.length; i++) {
      const c = charts[i];
      if (!c) continue;
      y += 6;
      ctx.font = 'bold 16px sans-serif'; ctx.fillStyle = '#233240';
      ctx.fillText(c.cap, P, y);
      y += 24;
      const cw = W - 2 * P;
      const chh = Math.min(cw * (c.h / c.w), 1400);
      ctx.drawImage(c.canvas, P, y, cw, chh);
      y += chh + 18;
    }

    const H = Math.ceil(y + P);

    // 3. capture report canvas -> JPEG
    const tmpPath = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: pdfNode,
        x: 0, y: 0, width: W, height: H,
        destWidth: W, destHeight: H,
        fileType: 'jpg', quality: 0.95,
        success: (r) => resolve(r.tempFilePath),
        fail: (err) => reject(err)
      });
    });

    // 4. wrap JPEG into a single-page PDF and save
    const jpeg = new Uint8Array(fs.readFileSync(tmpPath));
    const pdfBuf = buildImagePdf(jpeg, W, H);
    const topic = this.data.topic || 'TOPIC';
    const sd = this.rangeToken(this.data.startDate, this.data.startTime);
    const ed = this.rangeToken(this.data.endDate, this.data.endTime);
    const fname = '农田土壤墒情数据分析报告_' + topic + '_' + sd + '_' + ed + '.pdf';
    const fpath = wx.env.USER_DATA_PATH + '/' + fname;
    fs.writeFileSync(fpath, pdfBuf);

    wx.openDocument({
      filePath: fpath,
      fileType: 'pdf',
      showMenu: true,
      fail: () => {
        wx.showModal({
          title: '导出完成',
          content: 'PDF 已生成：' + fname + '\n路径：' + fpath,
          showCancel: false
        });
      }
    });
  }
});
