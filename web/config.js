/* config.js — 前端配置（占位值，可安全公开）
 * 本地真实值请写在同目录的 config.local.js 里（已被 .gitignore 排除）。
 * 也可以在页面右上角「设置」里直接填写 UID，浏览器会存到 localStorage。
 */
window.APP_CONFIG = window.APP_CONFIG || {
  DEFAULT_UID: 'YOUR_BEMFA_UID',   // 巴法云私钥 UID
  DEFAULT_TOPIC: 'Test01'          // MQTT 主题名，需与固件 MQTT_TOPIC 一致
};
