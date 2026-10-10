/* ============================================================================
 * config.example.h — 配置模板（占位值，可安全公开）
 *
 * 使用方法：把本文件复制为同目录下的 config.h，替换成自己的真实值。
 *   - 巴法云 UID：登录 bemfa.com → 控制台右上角「私钥」，即 MQTT 密码
 *   - 主题名 TOPIC：在固件 [模块 5] 的 MQTT_TOPIC 中修改（默认 Test01）
 * ============================================================================ */
#pragma once

#define SECRET_WIFI_SSID  "YOUR_WIFI_SSID"   // 2.4GHz WiFi 名称（ESP32 不支持 5GHz）
#define SECRET_WIFI_PWD   "YOUR_WIFI_PASSWORD"
#define SECRET_BEMFA_UID  "YOUR_BEMFA_UID"   // 巴法云私钥 UID，32 位十六进制字符串
