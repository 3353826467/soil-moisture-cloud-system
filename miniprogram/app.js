// app.js — 全局配置（从本地存储读取，用户可在设置页修改）
// 默认配置来自 config.js（仓库自带占位模板）。
// 本机使用时：把 config.js 里的 UID 换成自己的巴法云私钥，
// 或直接在小程序「设置」页填写 UID（会存到本地缓存，优先级更高）。
const DEFAULT_CFG = require('./config.js');

App({
  onLaunch() {
    // 首次启动读取本地保存的配置，没有则使用默认
    const saved = wx.getStorageSync('bemfa_cfg');
    if (saved && saved.uid && saved.topic) {
      this.globalData.UID   = saved.uid;
      this.globalData.TOPIC = saved.topic;
      this.globalData.SUB   = saved.topic + '/sub';
    } else {
      // 默认配置（首次启动使用，可点击"设置"修改）
      this.globalData.UID   = DEFAULT_CFG.UID;
      this.globalData.TOPIC = DEFAULT_CFG.TOPIC || 'Test01';
      this.globalData.SUB   = this.globalData.TOPIC + '/sub';
    }
    // 刷新间隔：本地优先（用户在设置页保存过的），否则用默认 30s（对齐 ESP32 上报间隔）
    const savedPoll = wx.getStorageSync('poll_ms');
    if (savedPoll && Number(savedPoll) >= 1000) {
      this.globalData.POLL_MS = Number(savedPoll);
    }
  },
  globalData: {
    UID: '',
    TOPIC: '',
    SUB: '',
    POLL_MS: 30000,   // 默认 30 秒轮询，对齐 ESP32 每 30s 上报一次；用户可在系统设置里改 1~60s
    API_HOST: 'https://apis.bemfa.com',
    // 出厂默认值（来自 config.local.js 或 config.js），设置页「清除配置」恢复默认时使用
    DEFAULT_UID: DEFAULT_CFG.UID,
    DEFAULT_TOPIC: DEFAULT_CFG.TOPIC || 'Test01'
  }
});