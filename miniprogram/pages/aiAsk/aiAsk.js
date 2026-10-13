// pages/aiAsk/aiAsk.js — 轻量 AI 问答：一问一答，不带对话历史
// 进入时必须先从 storage 里读到上个页面写好的数据上下文（key: ai_ask_ctx）
const AI = require('../../utils/ai.js');

Page({
  data: {
    ready: false,
    model: '',
    baseShort: '',
    question: '',
    answer: '',
    loading: false,
    error: '',
    ctxInfo: '',
    dots: ''
  },

  onLoad() {
    const cfg = AI.getCfg();
    const payload = wx.getStorageSync('ai_ask_ctx') || null;
    this._ctx = (payload && payload.ctx) || null;

    const ready = AI.cfgReady(cfg);
    this.setData({
      ready: ready,
      question: (payload && payload.question) || '',
      baseShort: ready ? String(cfg.base).replace(/^https?:\/\//, '') : '',
      ctxInfo: (this._ctx && this._ctx.summary) || ''
    });

    if (!ready) {
      this.setData({ error: '尚未配置 AI 后端地址，请到「设置 → 🤖 AI 助手」填写 server/server.js 的地址。' });
      return;
    }
    if (!this._ctx) {
      this.setData({ error: '没有拿到数据上下文，请从首页或「数据分析」页点「🤖 问 AI」进入。' });
      return;
    }
    this.ask();
  },

  onUnload() {
    this._stopDots();
  },

  onHide() {
    this._stopDots();
  },

  onQuestionInput(e) {
    this.setData({ question: e.detail.value });
  },

  onAsk() {
    const q = String(this.data.question || '').trim();
    if (!q) { wx.showToast({ title: '先写个问题', icon: 'none' }); return; }
    if (this.data.loading) return;
    this.ask();
  },

  ask() {
    const q = String(this.data.question || '').trim();
    if (!q) return;

    let ctxText = '';
    try { ctxText = AI.buildContext(this._ctx); } catch (e) { ctxText = ''; }

    const self = this;
    this.setData({ loading: true, error: '', answer: '' });
    this._startDots();

    AI.ask(q, ctxText).then(res => {
      self._stopDots();
      self.setData({ loading: false });
      if (!res.ok) {
        self.setData({ error: res.msg || '请求失败' });
        return;
      }
      const text = AI.stripMarkdown(res.text);
      self.setData({
        answer: text || '（模型返回了空内容，换个问法试试）',
        model: res.model || self.data.model
      });
      wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    });
  },

  onCopy() {
    if (!this.data.answer) return;
    wx.setClipboardData({
      data: this.data.answer,
      success() { wx.showToast({ title: '已复制', icon: 'success' }); }
    });
  },

  onGoSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  /* 等待时的小圆点动画，避免用户以为卡死 */
  _startDots() {
    this._stopDots();
    this._dotsTimer = setInterval(() => {
      const cur = this.data.dots || '';
      this.setData({ dots: cur.length >= 3 ? '' : cur + '·' });
    }, 500);
  },

  _stopDots() {
    if (this._dotsTimer) { clearInterval(this._dotsTimer); this._dotsTimer = null; }
  }
});
