const { drawTrend } = require('../../utils/trendChart.js');

const app = getApp();

Page({
  data: {
    name: '--',
    bandText: '--',
    points: 0
  },

  onLoad() {
    const p = app.globalData.__trendZoom || {};
    this.payload = p;
    this.setData({
      name: p.name || '--',
      bandText: p.band ? (p.band[0] + ' ~ ' + p.band[1]) : '--',
      points: (p.pts && p.pts.length) || 0
    });
  },

  onReady() {
    // 横屏下 canvas 尺寸稳定后再绘制
    setTimeout(() => this.draw(), 60);
  },

  onResize() {
    setTimeout(() => this.draw(), 60);
  },

  draw() {
    const p = this.payload || {};
    const pts = p.pts || [];
    const query = wx.createSelectorQuery().in(this);
    query.select('#zoomChart').fields({ node: true, size: true }).exec((res) => {
      if (!res || !res[0] || !res[0].node) return;
      const canvas = res[0].node;
      const ctx = canvas.getContext('2d');
      let dpr = 2;
      try {
        dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) ||
              (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2;
      } catch (e) { dpr = 2; }
      const W = res[0].width || 600;
      const H = res[0].height || 300;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.scale(dpr, dpr);

      drawTrend(ctx, W, H, {
        pts: pts,
        xMin: p.xMin,
        xMax: p.xMax,
        unit: p.unit,
        dec: p.dec,
        color: p.color,
        band: p.band,
        scale: 2      // 横屏大图：字号/线宽/圆点放大
      });
    });
  },

  onUnload() {
    try { app.globalData.__trendZoom = null; } catch (e) {}
  }
});
