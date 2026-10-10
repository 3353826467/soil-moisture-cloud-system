


// pages/settings/settings.js
const app = getApp();

Page({
  data: {
    uid: '',
    topic: '',
    pollSec: 30,               // 刷新间隔（秒），与 app.globalData.POLL_MS 同步；默认对齐 ESP32 上报 30s
    cloudBase: '',             // 云端历史（CloudBase getHistory 云函数地址），留空=不启用
    cloudToken: ''             // 访问令牌，未设置则留空
  },

  onLoad() {
    // 优先读本地保存的配置；否则用全局默认值
    const saved = wx.getStorageSync('bemfa_cfg');
    // 读取刷新间隔：本地优先，没有则用全局 POLL_MS（ms → s）
    const savedPoll = wx.getStorageSync('poll_ms');
    const pollSec   = savedPoll != null
      ? Math.round(Number(savedPoll) / 1000)
      : Math.round(app.globalData.POLL_MS / 1000);
    let cloudBase = '';
    let cloudToken = '';
    try {
      cloudBase = wx.getStorageSync('cloud_base') || 'https://nttrsqydcjysjfxxt-d2dszi66e6a29e-1484733482.ap-shanghai.app.tcloudbase.com/getHistory';
      cloudToken = wx.getStorageSync('cloud_token') || '';
    } catch (e) { /* 读取失败按未配置处理 */ }
    this.setData({
      uid:     saved.uid   || app.globalData.UID   || '',
      topic:   saved.topic || app.globalData.TOPIC || '',
      pollSec: isFinite(pollSec) && pollSec > 0 ? pollSec : 30,
      cloudBase: cloudBase,
      cloudToken: cloudToken
    });
  },

  onUidInput(e)   { this.setData({ uid: e.detail.value.trim() }); },
  onTopicInput(e) { this.setData({ topic: e.detail.value.trim() }); },
  onPollInput(e)  { this.setData({ pollSec: e.detail.value.replace(/[^0-9.]/g, '') }); },
  onCloudBaseInput(e)  { this.setData({ cloudBase: e.detail.value.trim() }); },
  onCloudTokenInput(e) { this.setData({ cloudToken: e.detail.value.trim() }); },

  onSaveCloud() {
    const base = this.data.cloudBase;
    const token = this.data.cloudToken;
    if (base && !/^https?:\/\//i.test(base)) {
      wx.showToast({ title: '地址需 http(s) 开头', icon: 'none' });
      return;
    }
    wx.setStorageSync('cloud_base', base);
    wx.setStorageSync('cloud_token', token);
    wx.showToast({
      title: base ? '已保存，优先读云端' : '已清空，恢复本地',
      icon: 'success'
    });
  },

  onTestCloud() {
    const base = this.data.cloudBase;
    if (!base) {
      wx.showToast({ title: '请先填云函数地址', icon: 'none' });
      return;
    }
    const token = this.data.cloudToken;
    let url = base + (base.indexOf('?') >= 0 ? '&' : '?') + 'limit=5000';
    if (token) url += '&token=' + encodeURIComponent(token);
    wx.showLoading({ title: '测试中…' });
    const t0 = Date.now();
    wx.request({
      url: url,
      method: 'GET',
      success: res => {
        wx.hideLoading();
        const j = res.data;
        if (j && j.code === 0 && Array.isArray(j.data)) {
          wx.showModal({
            title: '连接成功',
            content: '返回 ' + j.data.length + ' 条（' + (Date.now() - t0) + ' ms）',
            showCancel: false
          });
        } else {
          wx.showModal({
            title: '连接失败',
            content: '返回内容异常：' + JSON.stringify(j).slice(0, 120),
            showCancel: false
          });
        }
      },
      fail: err => {
        wx.hideLoading();
        wx.showModal({
          title: '连接失败',
          content: '请检查地址、网络，以及小程序后台是否已把该域名加入 request 合法域名。',
          showCancel: false
        });
      }
    });
  },

  onSave() {
    const uid = this.data.uid;
    const topic = this.data.topic;
    if (!uid) {
      wx.showToast({ title: '请填写 UID', icon: 'none' });
      return;
    }
    if (!topic) {
      wx.showToast({ title: '请填写主题', icon: 'none' });
      return;
    }
    // UID 简易校验：32 位 hex
    if (!/^[0-9a-fA-F]{32}$/.test(uid)) {
      wx.showModal({
        title: 'UID 格式提示',
        content: '巴法云 UID 应为 32 位十六进制字符。你填写的似乎不是标准格式，确认保存吗？',
        success: r => { if (r.confirm) this._doSave(uid, topic); }
      });
      return;
    }
    this._doSave(uid, topic);
  },

  _doSave(uid, topic) {
    // 写入本地存储 + 更新全局
    wx.setStorageSync('bemfa_cfg', { uid, topic });
    app.globalData.UID = uid;
    app.globalData.TOPIC = topic;
    app.globalData.SUB = topic + '/sub';

    wx.showToast({ title: '已保存', icon: 'success' });

    // 1 秒后自动返回首页
    setTimeout(() => wx.navigateBack(), 800);
  },

  onClear() {
    wx.showModal({
      title: '确认清除？',
      content: '将清除本地保存的巴法云配置，下次启动将使用默认示例值。',
      success: r => {
        if (r.confirm) {
          wx.removeStorageSync('bemfa_cfg');
          // 恢复默认
          app.globalData.UID   = app.globalData.DEFAULT_UID;
          app.globalData.TOPIC = app.globalData.DEFAULT_TOPIC || 'Test01';
          app.globalData.SUB   = app.globalData.TOPIC + '/sub';
          this.setData({ uid: app.globalData.UID, topic: app.globalData.TOPIC });
          wx.showToast({ title: '已恢复默认', icon: 'success' });
        }
      }
    });
  },

  // 保存刷新间隔：写本地 + 更新全局；首页 onShow 会自动重启定时器读到新值
  onSavePoll() {
    const sec = Number(this.data.pollSec);
    if (!isFinite(sec) || sec < 1) {
      wx.showToast({ title: '请输入 ≥ 1 秒', icon: 'none' });
      return;
    }
    if (sec > 60) {
      wx.showToast({ title: '最大 60 秒', icon: 'none' });
      return;
    }
    const ms = sec * 1000;
    wx.setStorageSync('poll_ms', ms);
    app.globalData.POLL_MS = ms;
    wx.showToast({ title: '已保存 ' + sec + ' 秒', icon: 'success' });
  }
});