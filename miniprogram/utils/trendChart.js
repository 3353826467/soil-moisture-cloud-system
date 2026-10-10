// 变化趋势图绘制（原图 / 横屏放大图共用）
// 调用方传入已 scale(dpr,dpr) 过的 ctx 与逻辑宽高，以及 opt：
//   { pts:[{x:unixMs,y:value}], xMin, xMax, unit, dec, color, band:[lo,hi], scale }
// scale 用于横屏大图放大字号/线宽/圆点；原图传 1。

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dateKeyOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 在每个「间隔 2 小时」的桶内挑一个最接近整点（偶数小时:00）的点，
// 返回待标注的点数组（按时间升序）。避免每个采样点都标，造成重叠。
function pickTwoHourLabels(pts) {
  const best = {};
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const d = new Date(p.x);
    const h2 = Math.floor(d.getHours() / 2) * 2;            // 0,2,4,...,22
    const bucketKey = dateKeyOf(p.x) + '_' + h2;
    const startMs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h2, 0, 0, 0).getTime();
    const dist = Math.abs(p.x - startMs);
    if (!best[bucketKey] || dist < best[bucketKey].dist) best[bucketKey] = { p: p, dist: dist };
  }
  return Object.keys(best).map(k => best[k].p);
}

// ARIMA(0,1,1) 单步滚动预测（≈EMA）。输入数值数组，返回下一时刻预测。
// 公式: ŷ_t = y_{t-1} + θ·(y_{t-1} - ŷ_{t-1})；θ 在滚动窗口内最小二乘估计。
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

function drawTrend(ctx, W, H, opt) {
  const s = opt.scale || 1;
  const m = { unit: opt.unit, dec: opt.dec, color: opt.color, band: opt.band };
  const pts = opt.pts || [];
  if (!pts.length) {
    ctx.fillStyle = '#a3b1bd'; ctx.font = (12 * s) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('no data', W / 2, H / 2);
    return;
  }

  const padL = 40 * s, padR = 12 * s, padT = 14 * s, padB = 24 * s;
  const cw = W - padL - padR, ch = H - padT - padB;

  // y 轴范围（含适宜区间带）
  let ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < pts.length; i++) { const v = pts[i].y; if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
  if (m.band) { ymin = Math.min(ymin, m.band[0]); ymax = Math.max(ymax, m.band[1]); }
  let pad = (ymax - ymin) * 0.12;
  if (!isFinite(pad) || pad <= 0) pad = Math.max(1, Math.abs(ymax) * 0.1);
  ymin -= pad; ymax += pad;
  const yspan = (ymax - ymin) || 1;

  // x 轴范围：优先用调用方给的选段时间窗
  let xMin = (typeof opt.xMin === 'number' && isFinite(opt.xMin)) ? opt.xMin : pts[0].x;
  let xMax = (typeof opt.xMax === 'number' && isFinite(opt.xMax)) ? opt.xMax : pts[pts.length - 1].x;
  if (!(xMax > xMin)) { xMin = pts[0].x; xMax = pts[pts.length - 1].x; }
  const xspan = (xMax - xMin) || 1;
  const X = t => padL + cw * (t - xMin) / xspan;
  const Y = v => padT + ch - ((v - ymin) / yspan) * ch;

  // 适宜区间带
  if (m.band) {
    const y1 = Y(m.band[1]), y2 = Y(m.band[0]);
    ctx.fillStyle = 'rgba(58,161,126,0.14)';
    ctx.fillRect(padL, Math.min(y1, y2), cw, Math.abs(y2 - y1));
  }

  // y 轴网格 + 刻度
  ctx.font = (10 * s) + 'px sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = ymin + (yspan * i) / 4, y = Y(v);
    ctx.strokeStyle = i === 0 ? '#c9d4de' : '#eef2f6'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + cw, y); ctx.stroke();
    ctx.fillStyle = '#8a9aa8'; ctx.fillText(Number(v).toFixed(m.dec), padL - 6 * s, y);
  }

  // 实时连续曲线（绘制抽稀，避免上千点卡顿）
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
    const vals = pts.map(p => p.y).filter(v => typeof v === 'number' && isFinite(v));
    const ar = arimaOneStep(vals);
    if (ar) {
      const lastP = pts[pts.length - 1], prevP = pts[pts.length - 2];
      const dt = (lastP.x - prevP.x) || (xMax - xMin) / pts.length;
      const fx = lastP.x + dt, fy = ar.next;
      // 95% 预测区间阴影带（±1.96·残差标准差），与论文 6.7 节口径一致。
      // 横向最小宽度 26px，避免整天视图下一个采样间隔太窄看不见。
      const half = 1.96 * ar.rmse;
      const yHi = Y(fy + half), yLo = Y(fy - half);
      const x0 = X(lastP.x), x1 = Math.max(X(fx), x0 + 26 * s);
      ctx.fillStyle = 'rgba(226,75,74,0.16)';
      ctx.fillRect(x0, Math.min(yHi, yLo), x1 - x0, Math.abs(yLo - yHi));
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

  // x 轴时间标签（沿时间轴均匀取 5 个刻度，显示本地 HH:MM）
  ctx.textBaseline = 'top'; ctx.fillStyle = '#8a9aa8'; ctx.font = (10 * s) + 'px sans-serif';
  const _fmtLocal = ms => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const TICKS = 5;
  for (let i = 0; i < TICKS; i++) {
    const t = xMin + (xspan * i) / (TICKS - 1);
    const x = X(t);
    ctx.textAlign = i === 0 ? 'left' : (i === TICKS - 1 ? 'right' : 'center');
    ctx.fillText(_fmtLocal(t), x, padT + ch + 6 * s);
  }

  // 数值标注：每隔 2 小时标一个数值+单位（贴近曲线，上下交错防重叠）
  const labels = pickTwoHourLabels(pts);
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

  // 末值徽章
  const lastP = pts[pts.length - 1];
  ctx.fillStyle = m.color; ctx.font = 'bold ' + (11 * s) + 'px sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText(lastP.y.toFixed(m.dec) + m.unit, padL + cw, padT + 2 * s);
}

module.exports = { drawTrend: drawTrend, arimaOneStep: arimaOneStep };
