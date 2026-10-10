// pages/index/index.js
const app = getApp();

function rssiLabel(r) {
  if (r === undefined || r === null) return '--';
  if (r >= -50) return '极强';
  if (r >= -65) return '强';
  if (r >= -75) return '中';
  if (r >= -85) return '弱';
  return '极弱';
}

// Unified display format: keep integers as-is, show 1 decimal for floats.
// ESP32 reports 25.6875 for soil temperature, 27.6 for air, 52/41 for humidity;
// without this helper the cards end up with mixed widths and the layout shifts.
function fmtSensor(v) {
  if (v === null || v === undefined) return '--';
  const n = Number(v);
  if (!isFinite(n) || n <= -99) return '--';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 顶部镜像派生 shHi：过湿带宽度 = 适宜带宽度 → shHi = shOpt + (shOpt - shLow)，夹紧 ≤100。
// 底部重旱阈值固定 30（生理常量），不参与派生。
function deriveShHi(shLow, shOpt) {
  const hi = shOpt + (shOpt - shLow);
  return Math.min(100, Math.max(shOpt + 1, Math.round(hi)));
}

Page({
  data: {
    sh: '--', st: '--', ah: '--', at: '--',
    rssi: null, rssiLabel: '--',
    level: '--',
    lastUpdate: '--',
    freshText: '', freshColor: '#94a3b8',   // 数据新鲜度（设备侧丢报时显式提示延迟）
    online: false,
    topic: '',
    // 阈值（与 ESP32 TomatoTh 对应：shLow/shHi 土壤湿度·自动灌溉触发/积水边界；
    // stLow/stHi 土壤温度告警；ahLow/ahHi 空气湿度告警；atLow/atHi 空气温度告警）
    thr: {
      shLow: 45, shHi: 80, shOpt: 65,
      stLow: 15, stHi: 25,
      ahLow: 50, ahHi: 80,
      atLow: 18, atHi: 28
    },
    // 灌溉决策建议（基于当前 sh + 阈值实时生成）
    adviceIcon: '🌱',
    adviceSummary: '等待数据…',
    adviceText: '请确保设备已上线。',
    adviceLevel: 'advice-normal',  // normal / warn / danger
    pollLabel: '30s',              // 初始占位，onLoad 会按真实 POLL_MS 覆盖（默认 30s 对齐 ESP32 上报）
    // 灌溉状态（来自设备上报 JSON 的 irr 字段："ON"/"OFF"）
    irrigating: false,   // 是否正在灌溉
    irrSince: 0,         // 本次灌溉起始时刻（ms），用于计算"已持续"
    irrElapsed: '00:00'  // 已持续时长 mm:ss
  },

  onLoad() {
    this.setData({ topic: app.globalData.TOPIC });
    this.setData({ pollLabel: Math.round(app.globalData.POLL_MS / 1000) + 's' });  // 状态栏显示真实间隔
    // 打开时先显示上次有效读数，避免设备短暂离线/命令覆盖时首页全“--”
    const cached = wx.getStorageSync('lastSensor');
    if (cached) this.setData(cached);
    // 阈值：先从本地缓存读（用户上次保存过），设备回传 thr 后再覆盖
    // 注意：缓存里可能是字符串（input 写入）或旧数据缺 shOpt，空字符串不能当 0 用
    const cachedThr = wx.getStorageSync('thr');
    if (cachedThr) {
      const need = ['shLow','shOpt','shHi','stLow','stHi','ahLow','ahHi','atLow','atHi'];
      const thr = Object.assign({}, this.data.thr);
      need.forEach(k => {
        const v = cachedThr[k];
        if (v !== '' && v != null) {
          const n = Number(v);
          if (isFinite(n)) thr[k] = n;
        }
      });
      this.setData({ thr });
    }
    // 灌溉状态：从缓存恢复（上次正在灌溉时退出小程序，回来后仍显示"正在灌溉中"并续算时长）
    const irrCache = wx.getStorageSync('irrState');
    if (irrCache && irrCache.on && irrCache.since) {
      this.setData({ irrigating: true, irrSince: irrCache.since });
      this._irrTick();
    }
  },

  onShow() {
    // 每次回到首页都重读一次配置（用户在设置页改了也能立刻生效）
    this.setData({ topic: app.globalData.TOPIC });
    this.setData({ pollLabel: Math.round(app.globalData.POLL_MS / 1000) + 's' });
    // 强制重启：用户可能在设置页改过刷新间隔，必须按最新 POLL_MS 跑
    // （之前只 !_timer 才创建，导致旧定时器始终用老间隔，直到 onHide 释放）
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._timer = setInterval(() => this.fetchLatest(), app.globalData.POLL_MS);
    // 灌溉计时器：1s 刷新一次"已持续 mm:ss"（只在灌溉中才有意义，开销极小）
    if (this._irrTimer) { clearInterval(this._irrTimer); this._irrTimer = null; }
    this._irrTimer = setInterval(() => { this._irrTick(); this._paintFreshness(); }, 1000);
    this.fetchLatest();
  },

  onHide() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._irrTimer) { clearInterval(this._irrTimer); this._irrTimer = null; }
  },

  // 页面被销毁（如 redirect）也务必清掉定时器，否则回调会指向已释放页面
  onUnload() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._irrTimer) { clearInterval(this._irrTimer); this._irrTimer = null; }
  },

  // 下拉刷新：用户随时手动拉一下即可强制同步，不用重启小程序
  onPullDownRefresh() {
    this.fetchLatest();
    wx.stopPullDownRefresh();
  },

  fetchLatest() {
    const uid   = app.globalData.UID;
    const topic = app.globalData.TOPIC;
    if (!uid || !topic) {
      wx.showModal({ title: '未配置', content: '请先到设置页填写巴法云密钥和主题。', showCancel: false });
      return;
    }
    wx.request({
      url: app.globalData.API_HOST + '/va/getmsg',
      method: 'GET',
      data: { uid, topic, type: 1, num: 1 },
      success: (res) => {
        if (res.data && res.data.code === 0 && res.data.data && res.data.data.length > 0) {
          try {
            const obj = JSON.parse(res.data.data[0].msg);
            // 兜底：ESP32 上报里没有 level 时，前端用当前阈值自己算（分级思路参照 NY/T 1782-2025）
            const shNum = Number(obj.sh);
            const thrNow = this.data.thr || {};
            const shLow = isFinite(Number(thrNow.shLow)) ? Number(thrNow.shLow) : 45;
            const shOpt = isFinite(Number(thrNow.shOpt)) ? Number(thrNow.shOpt) : 65;
            const shHi  = isFinite(Number(thrNow.shHi))  ? Number(thrNow.shHi)  : deriveShHi(shLow, shOpt);
            const level = obj.level || (
              isNaN(shNum) ? '--' :
              shNum < 30 ? '重旱' :
              shNum < shLow ? '轻旱' :
              shNum < shOpt ? '适宜' :
              shNum < shHi ? '过湿' : '积水'
            );
            const snap = {
              sh: fmtSensor(obj.sh), st: fmtSensor(obj.st),
              ah: fmtSensor(obj.ah), at: fmtSensor(obj.at),
              rssi: obj.rssi, rssiLabel: rssiLabel(obj.rssi),
              level: level,
              online: true,
              lastUpdate: this._fmtTime(res.data.data[0].time || new Date().toLocaleString())
            };
            // 记录数据落库时刻：设备侧丢报时（实测 30s 周期平均 174s 才到一条）
            // 前端显式显示延迟，避免被误认为页面卡住不刷新
            const parsed = Date.parse(String(res.data.data[0].time || '').replace(/-/g, '/'));
            if (isFinite(parsed)) this._lastDataMs = parsed;
            this.setData(snap);
            this._paintFreshness();
            wx.setStorageSync('lastSensor', snap);   // 缓存有效读数，离线时仍可显示
            // 灌溉状态：设备上报 irr:"ON"/"OFF"，设备是唯一真源，直接覆盖本地乐观值
            this._setIrr(this._irrOn(obj.irr));
            // 基于当前土壤湿度 + 阈值生成灌溉决策建议
            this.setData(this.buildAdvice(shNum, Number(obj.st), Number(obj.at), Number(obj.ah)));
            // 缓存原始读数，"保存阈值"后无需等下一帧就能重算建议
            this._latest = { sh: shNum, st: Number(obj.st), at: Number(obj.at), ah: Number(obj.ah) };
            // 设备回传了当前阈值：用 ESP32 真值覆盖本地缓存（设备是唯一真源）
            // 但只覆盖有效字段，避免旧固件/缺 shOpt 时把本地有效阈值冲成 NaN/空
            if (obj.thr && typeof obj.thr === 'object') {
              const fields = ['shLow','shOpt','shHi','stLow','stHi','ahLow','ahHi','atLow','atHi'];
              const thr = Object.assign({}, this.data.thr);
              fields.forEach(k => { const n = Number(obj.thr[k]); if (isFinite(n)) thr[k] = n; });
              this.setData({ thr });
              wx.setStorageSync('thr', thr);
              // 用新阈值立即重算本次建议，避免本次建议仍用旧的/空的缓存阈值
              if (this._latest && isFinite(this._latest.sh)) {
                this.setData(this.buildAdvice(this._latest.sh, this._latest.st, this._latest.at, this._latest.ah));
              }
            }
          } catch (e) {
            console.warn('JSON parse err', e);
            // 最新一条可能是下行命令字符串（irrigate_off 等），并非传感器 JSON。
            // 此时保留上次有效读数，避免首页变成“--”/误判离线。
            const cached = wx.getStorageSync('lastSensor');
            if (cached) this.setData(Object.assign({ online: true }, cached));
            // 命令本身也携带灌溉状态：自身/其他客户端刚下发过开关命令时同步状态，
            // 否则要等下一包传感器 JSON 才能刷新，"正在灌溉"会有最长一个上报周期的延迟。
            const raw = String(res.data.data[0].msg || '').trim();
            if (raw === 'irrigate_on' || raw === 'irrigate_pulse_30s') this._setIrr(true);
            else if (raw === 'irrigate_off') this._setIrr(false);
          }
        } else {
          this.setData({ online: false });
        }
      },
      fail: () => { this.setData({ online: false }); }
    });
  },

  _fmtTime(t) {
    if (typeof t === 'string' && t.indexOf('-') >= 0) return t.slice(11, 19);
    return new Date().toLocaleTimeString();
  },

  // ====== 数据新鲜度 ======
  // 固件上报周期为 30 s，但实测大量丢报（14.4 h 内仅 300 条，平均 174 s/条）。
  // 只显示数据时间会被误认为"页面不刷新"，这里把延迟显式暴露出来。
  _paintFreshness() {
    if (!this._lastDataMs) return;
    const s = Math.max(0, Math.floor((Date.now() - this._lastDataMs) / 1000));
    let txt, color;
    if (s < 45)       { txt = '刚刚';                                     color = '#16a34a'; }
    else if (s < 120) { txt = s + ' 秒前';                                color = '#16a34a'; }
    else if (s < 300) { txt = Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒前 · 上报延迟'; color = '#d97706'; }
    else              { txt = Math.floor(s / 60) + ' 分前 · 设备上报异常';  color = '#dc2626'; }
    if (this.data.freshText !== txt) this.setData({ freshText: txt, freshColor: color });
  },

  // ====== 灌溉状态（设备上报 irr:"ON"/"OFF"，本地点击时乐观更新） ======
  // 时长补零：不用 padStart，兼容低版本基础库
  _pad2(n) { return (n < 10 ? '0' : '') + n; },

  // 把设备上报的 irr 字段归一为布尔（兼容 "ON"/"OFF"、1/0、true/false）
  // 设备未上报（undefined）时维持当前状态，避免误清掉本地的灌溉中标记
  _irrOn(v) {
    if (v === undefined || v === null) return this.data.irrigating;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')   return v === 1;
    return String(v).toUpperCase() === 'ON';
  },

  // 每 1s 刷新"已持续 mm:ss"
  _irrTick() {
    if (!this.data.irrigating || !this.data.irrSince) return;
    const s = Math.max(0, Math.floor((Date.now() - this.data.irrSince) / 1000));
    this.setData({ irrElapsed: this._pad2(Math.floor(s / 60)) + ':' + this._pad2(s % 60) });
  },

  // 统一入口：切换灌溉状态（首帧为真时记录起始时刻并落缓存，退出小程序后可续算）
  _setIrr(on) {
    if (on) {
      const since = (this.data.irrigating && this.data.irrSince) ? this.data.irrSince : Date.now();
      this.setData({ irrigating: true, irrSince: since });
      wx.setStorageSync('irrState', { on: true, since });
    } else {
      this.setData({ irrigating: false, irrSince: 0, irrElapsed: '00:00' });
      wx.setStorageSync('irrState', { on: false, since: 0 });
    }
    this._irrTick();
  },

  // ====== 灌溉决策建议（基于当前读数 + 用户阈值实时计算） ======
  // 配色随建议等级切换，与蜂鸣器告警级别一一对应：
  //   重旱/积水 → danger（红），立即行动
  //   轻旱/过湿 → warn（橙），近期安排
  //   适宜      → normal（绿），维持现状
  buildAdvice(sh, st, at, ah) {
    // 阈值可能来自 input 字符串、旧缓存、缺 shOpt 的旧固件，统一转 Number 并给默认值兜底
    // 空字符串/undefined 时保持默认值，避免 input 清空瞬间把阈值当成 0
    const toNum = (v, d) => { if (v === '' || v == null) return d; const n = Number(v); return isFinite(n) ? n : d; };
    const shLow = toNum(this.data.thr.shLow, 45);
    const shOpt = toNum(this.data.thr.shOpt, 65);
    const rawShHi = Number(this.data.thr.shHi);
    const shHi = (isFinite(rawShHi) && rawShHi > 0) ? rawShHi : deriveShHi(shLow, shOpt);
    const t = {
      shLow: shLow, shOpt: shOpt, shHi: shHi,
      stLow: toNum(this.data.thr.stLow, 15), stHi: toNum(this.data.thr.stHi, 25),
      ahLow: toNum(this.data.thr.ahLow, 50), ahHi: toNum(this.data.thr.ahHi, 80),
      atLow: toNum(this.data.thr.atLow, 18), atHi: toNum(this.data.thr.atHi, 28)
    };
    if (!isFinite(sh)) {
      return { adviceIcon: '⏳', adviceSummary: '等待传感器数据…', adviceText: '请确保土壤湿度传感器连接正常。', adviceLevel: 'advice-normal' };
    }
    // 1) 先按土壤湿度判断主建议（5 档）
    let icon = '🌱', summary = '维持现状', text2 = '', level = 'advice-normal';
    if (sh < 30) {
      icon = '🚨'; summary = '土壤严重缺水，建议立即灌溉';
      text2 = '当前湿度仅 ' + sh.toFixed(1) + '%，处于重旱区间（<30%），作物根系可能受损，请尽快启动灌溉，或开启自动灌溉。';
      level = 'advice-danger';
    } else if (sh < t.shLow) {
      icon = '⚠️'; summary = '土壤轻度缺水，建议近期灌溉';
      text2 = '当前湿度 ' + sh.toFixed(1) + '%，低于阈值下限 ' + t.shLow + '%，建议优先在清晨或傍晚灌溉，减少蒸发。';
      level = 'advice-warn';
    } else if (sh >= t.shLow && sh < t.shOpt) {
      icon = '✅'; summary = '土壤湿度适宜';
      text2 = '当前湿度 ' + sh.toFixed(1) + '% 处于适宜区间 [' + t.shLow + '%,' + t.shOpt + '%），作物生长良好，维持现状即可。';
      level = 'advice-normal';
    } else if (sh < t.shHi) {
      icon = '💧'; summary = '土壤偏湿，暂缓灌溉';
      text2 = '当前湿度 ' + sh.toFixed(1) + '% 处于偏湿区间 [' + t.shOpt + '%,' + t.shHi + '%)，土壤过湿，建议加强通风并暂缓灌溉，注意根系病害风险。';
      level = 'advice-warn';
    } else {
      icon = '🌊'; summary = '土壤积水，建议排水检查';
      text2 = '当前湿度 ' + sh.toFixed(1) + '%，疑似积水（≥' + t.shHi + '%），请立即检查排水沟并暂停灌溉，避免烂根。';
      level = 'advice-danger';
    }

    // 2) 叠加温度/湿度越限提示（不改变主建议等级，但文案会追加）
    const extra = [];
    if (isFinite(st) && st > -99 && st < t.stLow) extra.push('土壤温度 ' + st.toFixed(1) + '℃ 偏低，注意保温');
    if (isFinite(at) && at > -99 && at > t.atHi) extra.push('空气温度 ' + at.toFixed(1) + '℃ 偏高，加强通风');
    if (isFinite(ah) && ah > -99 && ah > t.ahHi) extra.push('空气湿度 ' + Math.round(ah) + '% 偏高，注意病害');
    if (extra.length) {
      text2 += '（同步提示：' + extra.join('；') + '。）';
      // 若越限 2 项以上，warn 升级为 danger
      if (extra.length > 1 && level === 'advice-warn') level = 'advice-danger';
    }
    return { adviceIcon: icon, adviceSummary: summary, adviceText: text2, adviceLevel: level };
  },

  // ====== 远程控制 ======
  _postSub(msg, successHint) {
    const uid   = app.globalData.UID;
    const topic = app.globalData.TOPIC;
    if (!uid || !topic) {
      wx.showToast({ title: '请先到设置页配置', icon: 'none' });
      return;
    }
    wx.request({
      url: app.globalData.API_HOST + '/va/postmsg',
      method: 'POST',
      header: { 'content-type': 'application/x-www-form-urlencoded' },
      // 巴法云不存在 "/sub" 子主题（主题名仅限字母数字，只支持 /set /up 后缀）。
      // 直接推送到主主题，订阅该主题的设备即可收到下行命令。
      data: { uid, topic, type: 1, msg },
      success: (res) => {
        console.log('[下行] POST 返回', res.data);
        // code 0=成功, 40004=私钥或主题错误, 10002=请求参数有误
        if (res.data && res.data.code !== 0) {
          wx.showToast({ title: '下发失败 ' + (res.data.code || ''), icon: 'none' });
        } else if (successHint) {
          wx.showToast({ title: successHint, icon: 'success' });
        }
      },
      fail: () => wx.showToast({ title: '发送失败', icon: 'none' })
    });
  },

  // ====== 阈值编辑 ======
  // 每个输入框 oninput 实时把值写回 data.thr[key]，让用户能即时看到自己改了什么。
  onThInput(e) {
    const key = e.currentTarget.dataset.key;
    const val = e.detail.value;
    const thr = Object.assign({}, this.data.thr);
    thr[key] = val;
    const upd = { thr };
    this.setData(upd);
    // 输入实时预览：改动任一阈值输入立即用当前值重算建议，避免输入框和建议不同步
    if (this._latest && isFinite(this._latest.sh)) {
      this.setData(this.buildAdvice(this._latest.sh, this._latest.st, this._latest.at, this._latest.ah));
    }
  },
  onSaveThresholds() {
    // input 写入的是字符串，保存前先全部转 Number，防止本地缓存和后续建议逻辑把字符串当数字用。
    // shHi 不再由输入框提供：顶部镜像法强制按 shOpt+(shOpt-shLow) 派生，夹紧 ≤100。
    const need = ['shLow','shOpt','stLow','stHi','ahLow','ahHi','atLow','atHi'];
    const t = {};
    for (const k of need) {
      const raw = this.data.thr[k];
      if (raw === '' || raw == null) {
        wx.showToast({ title: '请填写 ' + k, icon: 'none' });
        return;
      }
      const n = Number(raw);
      if (!isFinite(n)) {
        wx.showToast({ title: '请检查 ' + k + ' 数值', icon: 'none' });
        return;
      }
      t[k] = n;
    }
    // 土壤湿度积水线由镜像法派生，不读取输入框
    if (!(t.shOpt > t.shLow)) {
      wx.showToast({ title: '适宜上界 shOpt 必须大于轻旱线 shLow', icon: 'none' });
      return;
    }
    t.shHi = deriveShHi(t.shLow, t.shOpt);
    // 合理性检查：min 必须 < max
    const pair = [['shLow','shHi'],['stLow','stHi'],['ahLow','ahHi'],['atLow','atHi']];
    for (const [lo, hi] of pair) {
      if (t[lo] >= t[hi]) {
        wx.showToast({ title: lo + ' 必须小于 ' + hi, icon: 'none' });
        return;
      }
    }
    if (!(t.shOpt > t.shLow && t.shOpt < t.shHi)) {
      wx.showToast({ title: '适宜上界须介于 shLow 与 shHi 之间', icon: 'none' });
      return;
    }
    // 1) 写回 data 并存本地：下次进入直接显示
    this.setData({ thr: t });
    wx.setStorageSync('thr', t);
    // 2) 下发 ESP32：set_th:key=val;key=val;... 命令，ESP32 解析后写 NVS 并立即生效
    const cmd = `set_th:shLow=${t.shLow};shOpt=${t.shOpt};shHi=${t.shHi};stLow=${t.stLow};stHi=${t.stHi};ahLow=${t.ahLow};ahHi=${t.ahHi};atLow=${t.atLow};atHi=${t.atHi}`;
    this._postSub(cmd, '阈值已保存');
    // 立即用新阈值重算"灌溉决策建议"，不用等下一帧（最长 30s）
    if (this._latest && isFinite(this._latest.sh)) {
      this.setData(this.buildAdvice(this._latest.sh, this._latest.st, this._latest.at, this._latest.ah));
    }
  },

  // 点击后乐观更新本地状态：不等下一个上报周期（最长 30s）就先显示"正在灌溉中"
  onIrrigateOn()   { this._postSub('irrigate_on',  '灌溉启动'); this._setIrr(true);  },
  onIrrigateOff()  { this._postSub('irrigate_off', '灌溉关闭'); this._setIrr(false); },
  onTestAlarm()    { this._postSub('test_alarm',       '测试报警 3 秒'); },
  onOpenAnalysis() { wx.navigateTo({ url: '/pages/analysis/analysis' }); },
  onOpenSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); }
});