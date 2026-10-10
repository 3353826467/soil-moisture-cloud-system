// config.js — 小程序配置（占位值，可安全公开）
// 本地真实值请写在同目录的 config.local.js 里（已被 .gitignore 排除）。
// 也可以在「设置」页里直接填写 UID 与主题名，会存到本地缓存。
module.exports = {
  UID: 'YOUR_BEMFA_UID',   // 巴法云私钥 UID
  TOPIC: 'Test01'          // MQTT 主题名，需与固件 MQTT_TOPIC 一致
};
