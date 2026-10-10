/* ============================================================================
 * 农田土壤墒情云端采集与数据分析系统 —— ESP32 端固件（模块化重排版）
 *
 * 来源：esp32_tomato_monitor_v3.ino
 * 说明：本文件仅调整代码“位置”，按功能模块归拢；未修改任何逻辑、数值与功能，
 *       行为与 v3 原版完全一致。原 v3 文件保持不变。
 * ============================================================================ */

// ============================================================================
//  [模块 1] 头文件引用
// ============================================================================
#include <Arduino.h>
#include <SPI.h>             // U8g2 库内部依赖 SPI，显式 include 防止找不到
#include <Wire.h>            // U8g2 库内部依赖 I2C (HW I2C 构造使用)
#include <U8g2lib.h>
#include <DHT.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <WiFi.h>
#include <HTTPClient.h>     // 巴法云微信告警推送（GET wechatWarn+type=2 自定义消息）
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>   // NVS 持久化：阈值重启后保留

// ---- 本地私有配置（WiFi 凭据 / 巴法云 UID）-------------------------------
// config.h       : 本地真实配置，已被 .gitignore 排除，不纳入版本库
// config.example.h: 仓库自带模板，clone 后请复制为 config.h 并填入真实值
#if defined(__has_include)
  #if __has_include("config.h")
    #include "config.h"
  #else
    #include "config.example.h"
  #endif
#else
  #include "config.h"
#endif
// ------------------------------------------------------------------------

// ============================================================================
//  [模块 2] 硬件引脚与常量定义
// ============================================================================
const int AO_PIN     = 34;    // HW-390 AO
const int LED_PIN    = 2;     // 板载 LED
const int DHT_PIN    = 4;     // DHT11
const int DS_PIN     = 5;     // DS18B20
const int BUZZER_PIN = 27;    // 有源蜂鸣器（低电平触发）
const int RELAY_PIN  = 25;    // 5V 继电器模块 (低电平触发)

const int ADC_DRY = 3680;     // 干燥状态(0%湿度)对应的 ADC 读数基准
const int ADC_WET = 1210;     // 浸水状态(100%湿度)对应的 ADC 读数基准
#define FILTER_SIZE 8         // ADC 滑动平均滤波的采样窗口大小

#define RELAY_ON  LOW
#define RELAY_OFF HIGH

// ============================================================================
//  [模块 3] 全局对象与实例
// ============================================================================
U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);  // 初始化 OLED 显示屏对象（硬件 I2C）
DHT dht(DHT_PIN, DHT11);                                           // 初始化 DHT11 温湿度传感器对象
OneWire oneWire(DS_PIN);                                           // 初始化单总线（挂载 DS18B20）
DallasTemperature dsSensors(&oneWire);                             // 基于单总线创建 DS18B20 温度库对象
Preferences prefs;             // NVS 键值存储对象（阈值持久化）
WiFiClient espClient;             // WiFi 网络客户端对象
PubSubClient mqtt(espClient);     // MQTT 客户端对象（基于 WiFi 客户端）

// ============================================================================
//  [模块 4] 全局测量值与运行标志
// ============================================================================
int   g_percent = 0;                                 // 当前土壤湿度百分比（0~100）
float g_soilTemp = 0, g_airHum = 0, g_airTemp = 0;   // 土壤温度 / 空气湿度 / 空气温度
bool  g_dhtOk = false, g_dsOk = false;               // 传感器本次读取是否成功的标志
const char* g_soilLevel = "--";                      // 5 档墒情等级（每帧刷新）
unsigned long lastIrrigationStart = 0;     // 上一次灌溉启动时刻（millis 时间戳）
// 注：loop 中计算 millis() - lastIrrigationStart >= cooldownMs 时启用节流；
bool irrigationActive = false;             // 灌溉是否正在进行中
unsigned long g_buzzUntil = 0;     // 自动阈值告警：当前蜂鸣脉冲结束时刻（非阻塞驱动）
unsigned long g_testBuzzUntil = 0; // 测试报警：3 秒试响结束时刻
unsigned long lastBuzzerMs = 0;    // 上次蜂鸣触发时刻（用于防抖）
unsigned long lastReportMs = 0;   // 上次成功上报的时刻（millis 时间戳）
bool irrigationEverStarted = false;   // 标记设备历史上是否曾经启动过灌溉

// ============================================================================
//  [模块 5] 配置结构体与网络凭据
// ============================================================================
struct TomatoTh {
  int   shLow  = 45, shHi = 80, shOpt = 65;  // shLow=轻旱/适宜断点；shOpt=适宜/过湿断点(适宜上界)；shHi=过湿/积水断点
  float stLow  = 15.0, stHi = 25.0;
  float atDayLow = 18.0, atDayHi = 28.0;
  int   ahLow = 50, ahHi = 80;
} th;
#define ENABLE_ENV_GATES 0     // 环境抑制门总开关（默认关闭）
struct IrrigationCfg {         // 自动灌溉参数配置结构
  unsigned long pulseMs   = 60000;    // 单次灌溉最长时间 60s（兜底，防止一直浇）
  unsigned long cooldownMs = 600000;  // 两次灌溉最小间隔 10min
  int   shStop  = 50;                 // 湿度达到此值即提前暂停（进入适宜区 45~65，取 50 留余量防抖）
  bool manualOverride = false;        // 是否被远程命令接管
} irr;
const char* WECHAT_UID    = SECRET_BEMFA_UID; // 巴法云私钥=UID（同 MQTT_TOKEN），值见 config.h
const char* WECHAT_DEVICE = "农田土壤墒情云端采集与数据分析系统";   // 设备名（显示在微信卡片）
const unsigned long WECHAT_ALERT_MIN_MS = 180000UL;             // 同一状态最小推送间隔 3min，防边界横跳刷屏
String g_lastAlertLevel = "适宜";   // 上一次推送的等级；恢复正常(适宜)即重置，下次异常才重推
bool   g_lastWechatOk  = true;      // 上次推送是否成功，失败则 1min 内短退避重试
unsigned long lastWechatAlertMs = 0;
const char* WIFI_SSID    = SECRET_WIFI_SSID;   // 值见 config.h
const char* WIFI_PWD     = SECRET_WIFI_PWD;    // 值见 config.h
const char* mqttServer = "bemfa.com";
const uint16_t mqttPort = 9501;
const char* MQTT_TOKEN    = SECRET_BEMFA_UID;  // 值见 config.h
const char* MQTT_TOPIC  = "Test01";               // 设备主题名：上报(publish) 与 接收下行(subscribe) 都用主主题
const unsigned long REPORT_INTERVAL = 30000UL;    // 30 秒一次

// ============================================================================
//  [模块 6] 函数前向声明
// ============================================================================
void reportData();   // 前向声明：定义见下方 void reportData()
bool pushWechatAlert(const String& msg);   // 前向声明：微信告警推送（定义见下方）

// ============================================================================
//  [模块 7] ADC 采样与滤波
// ============================================================================
int smoothADC(int s) {          // ADC 滑动平均滤波函数
  static int buf[FILTER_SIZE] = {0};        // 滤波环形缓冲区
  static int idx = 0, count = 0;            // 当前写入指针 / 已采集有效样本数
  long sum = 0;                            // 累加和
  buf[idx] = s;                            // 存入本次新采样
  idx = (idx + 1) % FILTER_SIZE;           // 指针环形前进
  if (count < FILTER_SIZE) count++;        // 样本未满窗口则计数+1
  for (int i = 0; i < count; i++) sum += buf[i];  // 累加所有有效样本
  return (int)(sum / count);               // 返回平均值（取整）
}

// ============================================================================
//  [模块 8] 传感器读取
// ============================================================================
float readSoilTemp() {          // 读取土壤温度函数
  dsSensors.requestTemperatures();                       // 向总线发起温度转换请求
  float t = dsSensors.getTempCByIndex(0);                // 读取第 1 个传感器摄氏温度
  if (t == DEVICE_DISCONNECTED_C || t == 85.0) {         // 断线或上电错误值(85℃)则重试一次
    delay(30);                                           // 延时等待后再读
    dsSensors.requestTemperatures();                     // 重新发起转换
    t = dsSensors.getTempCByIndex(0);                    // 重新读取温度
  }
  return t;                                               // 返回温度值
}

// ============================================================================
//  [模块 9] 阈值管理（校验 / NVS 持久化）
// ============================================================================
void sanitizeThresholds() {    // 阈值合法性收拢函数
  th.shLow   = constrain(th.shLow, 31, 60);  // >30 固定重旱线，避免轻旱档消失
  th.shHi    = constrain(th.shHi,  th.shLow + 20, 100);
  th.shOpt   = constrain(th.shOpt, th.shLow + 1, th.shHi - 1);  // 适宜上界须介于 shLow+1 与 shHi-1 之间
  th.stLow   = constrain(th.stLow, -20.0f, 50.0f);
  th.stHi    = constrain(th.stHi,  th.stLow + 1.0f, 80.0f);
  th.atDayLow= constrain(th.atDayLow, -10.0f, 50.0f);
  th.atDayHi = constrain(th.atDayHi,  th.atDayLow + 1.0f, 60.0f);
  th.ahLow   = constrain(th.ahLow, 0, 95);
  th.ahHi    = constrain(th.ahHi,  th.ahLow + 5, 100);
}
void loadThresholds() {             // 从 NVS 加载已保存阈值
  prefs.begin("tomato", true);                          // 以只读方式打开 NVS 命名空间
  th.shLow    = prefs.getInt("shLow",    th.shLow);     // 读轻旱线（无则取默认值）
  th.shHi     = prefs.getInt("shHi",     th.shHi);      // 读积水线
  th.shOpt    = prefs.getInt("shOpt",    th.shOpt);     // 读适宜上界
  th.stLow    = prefs.getFloat("stLow",  th.stLow);     // 读土壤温度下限
  th.stHi     = prefs.getFloat("stHi",   th.stHi);      // 读土壤温度上限
  th.atDayLow = prefs.getFloat("atDayL", th.atDayLow);  // 读空气温度下限
  th.atDayHi  = prefs.getFloat("atDayH", th.atDayHi);   // 读空气温度上限
  th.ahLow    = prefs.getInt("ahLow",    th.ahLow);     // 读空气湿度下限
  th.ahHi     = prefs.getInt("ahHi",     th.ahHi);      // 读空气湿度上限
  sanitizeThresholds();          // 读取历史 NVS 值后收拢到合法区间
  prefs.end();                   // 关闭 NVS
  Serial.printf("[阈值] 已从 NVS 加载 sh=%d/%d/%d st=%.1f-%.1f at=%.1f-%.1f ah=%d-%d\n",
                th.shLow, th.shOpt, th.shHi, th.stLow, th.stHi, th.atDayLow, th.atDayHi, th.ahLow, th.ahHi);
}
void saveThresholds() {             // 保存当前阈值到 NVS
  prefs.begin("tomato", false);                         // 以可写方式打开 NVS 命名空间
  prefs.putInt("shLow",    th.shLow);                  // 存轻旱线
  prefs.putInt("shHi",     th.shHi);                   // 存积水线
  prefs.putInt("shOpt",    th.shOpt);                  // 存适宜上界
  prefs.putFloat("stLow",  th.stLow);                  // 存土壤温度下限
  prefs.putFloat("stHi",   th.stHi);                   // 存土壤温度上限
  prefs.putFloat("atDayL", th.atDayLow);               // 存空气温度下限
  prefs.putFloat("atDayH", th.atDayHi);                // 存空气温度上限
  prefs.putInt("ahLow",    th.ahLow);                  // 存空气湿度下限
  prefs.putInt("ahHi",     th.ahHi);                   // 存空气湿度上限
  prefs.end();                                          // 关闭 NVS
}

// ============================================================================
//  [模块 10] 执行器：蜂鸣器告警
// ============================================================================
// 统一驱动：自动阈值告警(g_buzzUntil) 与 测试报警(g_testBuzzUntil) 通过“任一为真即响”
// 合并，二者互不抢占引脚、互不影响；分别到期即停，不会拖累对方。
void updateBuzzer() {             // 蜂鸣器统一驱动函数
  bool ring = (millis() < g_testBuzzUntil) || (millis() < g_buzzUntil);  // 任一告警为真则响
  digitalWrite(BUZZER_PIN, ring ? LOW : HIGH);          // 低电平触发：LOW 响 / HIGH 停
}
void tryBuzzer(int duration_ms = 800) {   // 触发一次自动阈值告警蜂鸣（非阻塞）
  // 非阻塞：仅记录本次自动告警脉冲的结束时刻，由 loop 末尾 updateBuzzer() 统一控制引脚。
  // 去掉原 alarmMuted 全局静音开关——测试报警不得影响自动阈值告警。
  if (millis() - lastBuzzerMs > 1500UL) {               // 防抖：1.5 秒内不重复触发
    g_buzzUntil = millis() + duration_ms;               // 记录本次蜂鸣结束时刻
    lastBuzzerMs = millis();                            // 记录触发时刻
  }
}

// ============================================================================
//  [模块 11] 执行器：自动灌溉
// ============================================================================
void tryAutoIrrigate() {            // 自动灌溉条件判定与启动函数
  if (irr.manualOverride) return;  // 被远程命令接管则跳过自动灌溉
  if (irrigationActive) return;    // 已在灌溉中则跳过
  // 冷却节流只对「曾经启动过」之后生效。未启动过则无视 cooldown（避免上电头 10 分钟无论多旱都不出水）
  if (irrigationEverStarted && millis() - lastIrrigationStart < irr.cooldownMs) return;  // 冷却期未到则跳过
  // 执行面：湿度低于 shLow 才开闸；空气温度进入 [atDayLow-3, atDayHi] 白天窗口
  // （atDayHi 上限默认 28℃，超过视为午间高温时段，跳过补水）
  bool airInWindow = g_dhtOk && g_airTemp >= (th.atDayLow - 3) && g_airTemp <= th.atDayHi;  // 空气温度是否处于白天窗口
  if (g_percent < th.shLow && airInWindow) {   // 湿度低于轻旱线且温度合适才灌溉
#if ENABLE_ENV_GATES
    // 可选环境门：土壤温度越出 [stLow,stHi]、或空气湿度过高(ahHi) 时抑制灌溉。
    // 默认关闭：出厂阈值 stHi=25℃，与本实验实测土壤温度(25.8~27.2℃)冲突，
    // 直接开启会导致自动灌溉永远被跳过；如需全量执行请把该宏置 1 并同步调大 stHi。
    if (g_dsOk && (g_soilTemp < th.stLow || g_soilTemp > th.stHi)) {  // 土壤温度越界则跳过本轮
      Serial.printf("[灌溉] 土壤温度 %.1f℃ 越出 [%.1f,%.1f]，本轮跳过\n", g_soilTemp, th.stLow, th.stHi);
      return;
    }
    if (g_dhtOk && g_airHum > th.ahHi) {       // 空气湿度过高（过湿环境）则跳过
      Serial.printf("[灌溉] 空气湿度 %d%% > ahHi=%d，过湿环境不补水\n", (int)g_airHum, th.ahHi);
      return;
    }
#endif
    digitalWrite(RELAY_PIN, RELAY_ON);         // 开继电器，启动灌溉
    irrigationActive = true;                   // 标记灌溉进行中
    irrigationEverStarted = true;              // 标记历史上曾启动过
    lastIrrigationStart = millis();            // 记录启动时刻
    Serial.println("[自动灌溉] 启动");
  }
}

// ============================================================================
//  [模块 12] 墒情等级判定
// ============================================================================
const char* judgeSoilMoisture(int pct) {   // 根据湿度百分比判定 5 档墒情等级
  // v3：断点读取远程阈值 shLow(轻旱线)/shOpt(适宜上界)/shHi(积水线)；30 为固定生理常量
  if (pct < 30)            return "重旱";   // <30 重旱（固定）
  else if (pct < th.shLow) return "轻旱";   // <轻旱线 轻旱（可远程调）
  else if (pct < th.shOpt) return "适宜";   // <适宜上界 适宜（可远程调）
  else if (pct < th.shHi)  return "过湿";   // <积水线 过湿（可远程调）
  else                     return "积水";   // 其余 积水
}

// ============================================================================
//  [模块 13] 微信告警推送
// ============================================================================
// 巴法云微信告警推送（GET wechatWarn，type=2 自定义消息：首行作为通知标题显示）
// 设备主动调巴法云接口，巴法云转发到用户绑定的微信（公众号"巴法云"服务通知）。
// GET wechatWarn：message 首行作为通知卡片标题显示，因此告警消息已自带"墒情告警："前缀，
// 整条文案（如"墒情告警：土壤湿度仅25%【重旱】，请尽快灌溉！"）即卡片标题，正文区域为空；
// 较旧版 wechatAlertJson（POST）平台固定标题更灵活。中文字段置于 URL 需 percent-encode。
// 仅在 WiFi 在线时调用；失败静默返回 false，不影响主流程（由调用方短退避重试）。
static String urlEncode(const String& s) {    // 轻量 percent-encode（GET 中文 message 必须）
  const char* hex = "0123456789ABCDEF";        // RFC3986 unreserved 不编码：字母数字 - _ . ~
  String out;
  out.reserve(s.length() * 3);
  for (int i = 0; i < (int)s.length(); i++) {
    unsigned char c = (unsigned char)s[i];
    bool unreserved = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') ||
                       (c >= 'A' && c <= 'Z') || c == '-' || c == '_' ||
                       c == '.' || c == '~';
    if (unreserved) { out += (char)c; }
    else { out += '%'; out += hex[c >> 4]; out += hex[c & 0xF]; }
  }
  return out;
}
bool pushWechatAlert(const String& msg) {   // 微信告警推送函数
  if (WiFi.status() != WL_CONNECTED) return false;      // 离线则直接返回失败
  HTTPClient http;                                      // 创建 HTTP 客户端
  http.setTimeout(5000);                                // 设置整体超时 5 秒
  http.setConnectTimeout(5000);                         // 设置连接超时 5 秒
  // GET wechatWarn：调用方传入的 msg 已自带"墒情告警："前缀，整条文案即作为通知卡片标题
  String url = "http://apis.bemfa.com/vb/wechat/v1/wechatWarn";
  url += "?uid=" + String(WECHAT_UID);                 // 用户私钥
  url += "&type=2";                                     // 自定义消息（首行作为通知标题）
  url += "&device=" + urlEncode(String(WECHAT_DEVICE)); // 设备名（中文需 percent-encode）
  url += "&message=" + urlEncode(msg);                  // 整条告警文案即首行标题（含"墒情告警："前缀）
  url += "&group=default";                              // 不分组
  if (!http.begin(url)) {                               // 初始化 GET 请求
    Serial.println("[微信] 推送初始化失败");
    return false;
  }
  int code = http.GET();                               // 发送 GET 请求
  bool ok = (code == HTTP_CODE_OK);                     // 判断是否成功(200)
  if (ok) Serial.printf("[微信] 推送成功: %s\n", http.getString().c_str());  // 成功打印返回
  else    Serial.printf("[微信] 推送失败 http=%d\n", code);                  // 失败打印错误码
  http.end();                                           // 结束 HTTP 请求
  return ok;                                            // 返回推送结果
}

// ============================================================================
//  [模块 14] 网络连接（WiFi / MQTT）
// ============================================================================
void setupWifi() {              // WiFi 连接初始化函数
  WiFi.mode(WIFI_STA);                                // 设为站点(客户端)模式
  WiFi.setSleep(false);                              // 关闭 WiFi 节能睡眠（避免后台断流式丢包）
  WiFi.persistent(false);                            // 不写 ESP32 NVS（重启不保留旧 SSID，避免热点切换残留）
  WiFi.begin(WIFI_SSID, WIFI_PWD);                   // 使用配置的账号密码开始连接
  Serial.print("WiFi");                              // 串口打印提示符
  int n = 0;                                         // 重试计数器
  while (WiFi.status() != WL_CONNECTED && n++ < 20) { delay(500); Serial.print("."); }  // 等待连接，最长约 10 秒
  if (WiFi.status() == WL_CONNECTED)                 // 连接成功
    Serial.printf("\n[WiFi] OK RSSI=%d\n", WiFi.RSSI());   // 打印信号强度(RSSI)
  else
    Serial.println("\n[WiFi] 失败继续本地模式");          // 失败则转入本地运行模式
}
// MQTT 重连退避：连续失败后逐步拉长间隔，避免 1 秒/次地猛砸 bemfa.com:9501 触发路由器拖黑
static unsigned long lastMqttAttemptMs = 0;   // 上次尝试 MQTT 连接的时刻
static unsigned long mqttBackoffMs = 5000;   // 第一次 5s，往后翻倍，最多 60s（退避间隔）

void ensureMqtt() {               // 维护 MQTT 长连接的函数
  if (mqtt.connected()) {         // 已处于连接状态
    mqttBackoffMs = 5000;         // 重置退避间隔
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {     // WiFi 离线
    // WiFi 离线：每 10s 触发一次 WiFi 重连
    static unsigned long lastWifiReconnectMs = 0;   // 上次 WiFi 重连时刻
    if (millis() - lastWifiReconnectMs > 10000UL) {  // 距上次重连超过 10 秒
      lastWifiReconnectMs = millis();
      Serial.println("[WiFi] 失联，重新尝试连接");
      WiFi.reconnect();             // 触发 WiFi 重连
    }
    return;
  }
  // WiFi 在线但 MQTT 未连接 → 按退避节奏去试
  if (millis() - lastMqttAttemptMs < mqttBackoffMs) return;  // 未到退避时间则本次跳过
  lastMqttAttemptMs = millis();                             // 记录本次尝试时刻

  // 先清残留 socket 状态，避免半关闭 socket 阻塞下一次 connect()
  mqtt.disconnect();                                       // 先断开可能存在的残留 socket
  Serial.printf("[MQTT] 尝试连接... backoff=%lus\n", mqttBackoffMs / 1000);

  if (!mqtt.connect(MQTT_TOKEN)) {                         // 连接失败
    int s = mqtt.state();                                  // 取 MQTT 错误码
    Serial.printf("[MQTT] 失败 state=%d (-4超时/-2连接失败/4凭证/5鉴权)\n", s);
    // -2/-4 等网络层错误 → 退避翻倍（最多 60s）
    if (s == -2 || s == -4 || s == -3) {                  // 网络层错误
      mqttBackoffMs = (mqttBackoffMs < 60000UL) ? mqttBackoffMs * 2 : 60000UL;  // 退避翻倍，上限 60 秒
    }
    // 4/5 等鉴权错误 → 不要指数退避（token 不会自己变），维持当前间隔
    return;
  }
  Serial.printf("[MQTT] 已连接，订阅 %s\n", MQTT_TOPIC);
  mqtt.subscribe(MQTT_TOPIC);    // 订阅主主题接收下行命令（重连后必须重新订阅）
}

// ============================================================================
//  [模块 15] 数据上报（上行）
// ============================================================================
void reportData() {              // 上报传感器数据到云端的函数
  StaticJsonDocument<768> doc;    // 9 个顶层字段 + 8 项 thr 嵌套对象；512 不够，扩到 768 防序列化失败
  doc["t"]    = millis() / 1000;                          // 时间戳（秒）
  doc["sh"]   = g_percent;                                // 土壤湿度百分比
  doc["st"]   = g_dsOk  ? g_soilTemp : -99;               // 土壤温度（失败发 -99）
  doc["ah"]   = g_dhtOk ? (int)g_airHum : -99;            // 空气湿度（失败发 -99）
  doc["at"]   = g_dhtOk ? g_airTemp : -99;                // 空气温度（失败发 -99）
  doc["rssi"] = WiFi.RSSI();                              // WiFi 信号强度
  doc["irr"]  = irrigationActive ? "ON" : "OFF";          // 灌溉状态
  doc["level"] = g_soilLevel;  // 土壤墒情等级（重旱/轻旱/适宜/过湿/积水）
  // 当前阈值（小程序首次进入时显示，编辑保存后由下一次 reportData 回传新值生效）
  JsonObject thr = doc.createNestedObject("thr");         // 创建嵌套的阈值对象
  thr["shLow"] = th.shLow;                                // 轻旱线
  thr["shHi"]  = th.shHi;                                 // 积水线
  thr["shOpt"] = th.shOpt;                                // 适宜上界
  thr["stLow"] = th.stLow;                                // 土壤温度下限
  thr["stHi"]  = th.stHi;                                 // 土壤温度上限
  thr["atLow"] = th.atDayLow;                             // 空气温度下限(白天)
  thr["atHi"]  = th.atDayHi;                              // 空气温度上限(白天)
  thr["ahLow"] = th.ahLow;                                // 空气湿度下限
  thr["ahHi"]  = th.ahHi;                                 // 空气湿度上限
  char buf[1024];                                         // JSON 序列化缓冲区
  size_t n = serializeJson(doc, buf, sizeof(buf));        // 把文档序列化为 JSON 字符串
  // 必须先判 connected，否则 publish 在未连接时会静默失败，导致串口有数据但云端没有
  // 额外前置 WiFi 存活检查：WiFi 已断但 mqtt.connected() 尚未刷新的瞬间，跳过本次，由下方 publish 失败分支统一触发重连
  if (n > 0 && mqtt.connected() && WiFi.status() == WL_CONNECTED) {   // 条件都满足才发布
    if (!mqtt.publish(MQTT_TOPIC, buf, true)) {           // 发布失败
      // TCP 可能已"半死"：connected() 仍返回 true 但底层 socket 写不进，导致一直 publish 失败却连不上重连
      // 主动断开，让下一轮 ensureMqtt() 重新握手，避免卡死在"在线但传不上"
      Serial.println("[MQTT] publish 失败：强制断开，下轮重连");
      mqtt.disconnect();                                  // 强制断开，下轮重连
    }
  }
}

// ============================================================================
//  [模块 16] 下行命令处理（MQTT 回调）
// ============================================================================
void onMqttMsg(char* topic, byte* payload, unsigned int len) {   // MQTT 下行消息回调函数
  String cmd = String((char*)payload, len);              // 将收到的字节拼装成命令字符串
  cmd.trim();                                            // 去除首尾空白字符
  if (cmd.startsWith("{")) return;                       // 以 "{" 开头说明是自身上报的 JSON，直接忽略
  Serial.printf("[MQTT下] %s\n", cmd.c_str());           // 打印收到的命令内容

  if (cmd == "irrigate_on") {                            // 收到强制开灌命令
    digitalWrite(RELAY_PIN, RELAY_ON);                   // 继电器吸合（开启负载）
    irrigationActive = true;                             // 标记灌溉进行中
    lastIrrigationStart = millis();                      // 记录本次启动时刻
    Serial.println("[控制] 灌溉强制开");                  // 打印日志
  } else if (cmd == "irrigate_off") {                    // 收到强制关灌命令
    digitalWrite(RELAY_PIN, RELAY_OFF);                  // 继电器断开（关闭负载）
    irrigationActive = false;                            // 标记灌溉停止
    Serial.println("[控制] 灌溉强制关");
  } else if (cmd == "irrigate_pulse_30s") {              // 收到 30 秒脉冲灌溉命令
    digitalWrite(RELAY_PIN, RELAY_ON);                   // 继电器吸合
    irrigationActive = true;                             // 标记灌溉中
    lastIrrigationStart = millis() - (irr.pulseMs - 30000);  // 把启动时刻前移，使 30 秒后自动停止
    Serial.println("[控制] 脉冲灌溉 30s");
  } else if (cmd == "test_alarm") {                      // 收到报警测试命令
    g_testBuzzUntil = millis() + 3000UL;                 // 测试报警：响 1 秒后自动停止
    Serial.println("[控制] 测试报警：响 1 秒（不影响自动阈值告警）");
  } else if (cmd == "wechat_test") {                     // 收到微信推送测试命令
    bool ok = pushWechatAlert("【测试】农田土壤墒情系统微信推送正常");  // 调用微信推送函数
    Serial.printf("[控制] 微信测试推送 %s\n", ok ? "成功" : "失败");     // 打印推送结果
  } else if (cmd.startsWith("set_th:")) {                // 收到阈值更新命令（格式 set_th:key=val;...）
    // 阈值更新协议: set_th:key1=value1;key2=value2;...
    // 支持 key: shLow shOpt shHi stLow stHi atLow(=atDayLow) atHi(=atDayHi) ahLow ahHi
    // 支持部分更新——只更新已出现的字段，未给字段保留原值。
    String payload = cmd.substring(7);                   // 去掉 "set_th:" 前缀，得到 key=val;... 部分
    int parsed = 0;                                      // 已成功解析的字段计数
    int start = 0;                                       // 当前解析起点
    while (start <= payload.length()) {                  // 循环解析每个字段
      int sep = payload.indexOf('=', start);             // 找键值分隔符 '='
      if (sep < 0) break;                                // 找不到等号则结束解析
      String key = payload.substring(start, sep);        // 提取键名
      int end = payload.indexOf(';', sep);               // 找字段分隔符 ';'
      String val;                                        // 字段值
      if (end < 0) {                                     // 已是最后一个字段（没有分号）
        val = payload.substring(sep + 1);                // 取剩余部分为值
        end = payload.length();
      } else {                                           // 中间字段
        val = payload.substring(sep + 1, end);           // 取区间部分为值
      }
      if      (key == "shLow") th.shLow    = val.toInt();    // 轻旱线赋值
      else if (key == "shHi")  th.shHi     = val.toInt();    // 积水线赋值
      else if (key == "shOpt") th.shOpt    = val.toInt();    // 适宜上界赋值
      else if (key == "stLow") th.stLow    = val.toFloat();  // 土壤温度下限赋值
      else if (key == "stHi")  th.stHi     = val.toFloat();  // 土壤温度上限赋值
      else if (key == "atLow") th.atDayLow = val.toFloat();  // 空气温度下限(白天)赋值
      else if (key == "atHi")  th.atDayHi  = val.toFloat();  // 空气温度上限(白天)赋值
      else if (key == "ahLow") th.ahLow    = val.toInt();    // 空气湿度下限赋值
      else if (key == "ahHi")  th.ahHi     = val.toInt();    // 空气湿度上限赋值
      parsed++;                                          // 解析计数 +1
      start = end + 1;                                   // 移动到下一字段起点
      if (end >= payload.length()) break;                // 已到末尾则退出
    }
    if (parsed > 0) {                                    // 至少有一个字段被解析
      sanitizeThresholds();    // 收拢非法区间后再落盘
      saveThresholds();        // 保存到 NVS 持久化
      Serial.printf("[阈值] 已更新并保存 NVS (%d 项): sh=%d/%d/%d st=%.1f-%.1f at=%.1f-%.1f ah=%d-%d\n",
                    parsed, th.shLow, th.shOpt, th.shHi, th.stLow, th.stHi, th.atDayLow, th.atDayHi, th.ahLow, th.ahHi);
    } else {
      Serial.println("[阈值] set_th 格式错误（未识别任何字段）");
    }
  } else if (cmd == "get") {                             // 收到立即上报命令
    // 强制立即上报一条
    lastReportMs = millis() - REPORT_INTERVAL;          // 把上报计时清零，触发下一轮立即上报
  }
  // 收到任何下行命令后立即回发一次传感器数据，覆盖 Test01 主主题上残留的命令字符串
  // （巴法云只保留主题最新一条消息，否则小程序会把命令当 JSON 解析失败而显示“--”）
  reportData();                                          // 回发当前传感器数据
}

// ============================================================================
//  [模块 17] OLED 显示
// ============================================================================
void drawOLED(bool mqttOn) {          // OLED 屏幕绘制函数
  u8g2.clearBuffer();                 // 清空显示缓冲区

  // 第 0 行：墒情等级 + WiFi/MQTT 状态（y=12 避免顶部被切）
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);   // 设置中文字体
  u8g2.setCursor(0, 12);                    // 定位光标到第 0 行
  u8g2.print("【");
  u8g2.print(g_soilLevel);                  // 打印当前墒情等级
  u8g2.print("】");
  u8g2.setFont(u8g2_font_6x12_tr);          // 切换为小号英文字体
  u8g2.setCursor(72, 12);
  u8g2.print(WiFi.status() == WL_CONNECTED ? "WiFi" : "");  // 打印 WiFi 连接状态
  u8g2.setCursor(116, 12);
  u8g2.print(mqttOn ? "上传" : "本地");      // 打印工作模式（上传/本地）

  // 第 1 行：土壤湿度（y=24，12 px 行高）
  u8g2.setFont(u8g2_font_wqy12_t_gb2312);
  u8g2.setCursor(0, 24);
  u8g2.print("土壤湿度:");
  u8g2.print(g_percent);                    // 打印土壤湿度数值
  u8g2.print("%");

  // 第 2 行：土壤温度
  u8g2.setCursor(0, 36);
  u8g2.print("土壤温度:");
  if (g_dsOk) { u8g2.print(g_soilTemp, 1); u8g2.print("℃"); }  // 正常则打印温度
  else        u8g2.print("--");                                // 失败显示 --

  // 第 3 行：空气湿度
  u8g2.setCursor(0, 48);
  u8g2.print("空气湿度:");
  if (g_dhtOk) { u8g2.print((int)g_airHum); u8g2.print("%"); }  // 正常则打印湿度
  else         u8g2.print("--");                                // 失败显示 --

  // 第 4 行：空气温度 + 灌溉状态
  u8g2.setCursor(0, 60);
  u8g2.print("空气温度:");
  if (g_dhtOk) { u8g2.print(g_airTemp, 1); u8g2.print("℃"); }   // 正常则打印温度
  else         u8g2.print("--");                                 // 失败显示 --
  u8g2.setFont(u8g2_font_6x12_tr);
  u8g2.setCursor(96, 60);
  u8g2.print(irrigationActive ? "I:ON" : "I:OFF");   // 打印灌溉状态

  u8g2.sendBuffer();                   // 把缓冲区内容刷新到屏幕
}

// ============================================================================
//  [模块 18] Setup 上电初始化
// ============================================================================
void setup() {                        // 上电初始化函数
  Serial.begin(115200);               // 初始化串口，波特率 115200
  delay(500);                         // 延时等待系统稳定

  pinMode(AO_PIN, INPUT);             // 湿度模拟输入引脚
  pinMode(LED_PIN, OUTPUT);           // 板载 LED 输出引脚
  // 先写电平再切 OUTPUT，消除 pinMode 切换瞬间电平不确定导致的误响/误动作
  digitalWrite(BUZZER_PIN, HIGH);     // 蜂鸣器低电平触发：HIGH = 静音
  digitalWrite(RELAY_PIN, RELAY_OFF); // 继电器默认断开（不灌溉）
  pinMode(BUZZER_PIN, OUTPUT);        // 蜂鸣器输出引脚
  pinMode(RELAY_PIN, OUTPUT);         // 继电器输出引脚

  dht.begin();                        // 启动 DHT11
  dsSensors.begin();                  // 启动 DS18B20 总线扫描
  Serial.printf("[DS18B20] 找到 %d 个\n", dsSensors.getDeviceCount());  // 打印发现的传感器数量

  u8g2.begin();                       // 初始化 OLED
  u8g2.enableUTF8Print();             // 开启 UTF-8 中文打印
  u8g2.setBusClock(100000);           // 设置 I2C 总线时钟 100k
  u8g2.setPowerSave(0);               // 关闭 OLED 节能模式

  // ESP32 Arduino v3.x 默认开启 loopTask WDT(5秒)，loop 每秒执行天然喂狗
  // 故不再手动调用 esp_task_wdt_init / add / reset

  loadThresholds();   // NVS 读取阈值（未保存过则用 TomatoTh 默认值）

  setupWifi();                       // 初始化并连接 WiFi
  mqtt.setServer("bemfa.com", 9501); // 设置 MQTT 服务器地址与端口
  mqtt.setKeepAlive(60);             // 设置保活间隔 60 秒
  mqtt.setBufferSize(1280);          // 默认 256 字节偏小，留足余量（长 topic/重连握手安全）
  mqtt.setCallback(onMqttMsg);       // 回调设置一次即可，且必须在订阅之前

  Serial.println("\n================================");
  Serial.println(" 农田土壤墒情云端采集与数据分析系统  启动");
  Serial.println("================================");
}

// ============================================================================
//  [模块 19] 主循环 loop
// ============================================================================
void loop() {                        // 主循环（每秒执行一次）
  int rawADC    = analogRead(AO_PIN);                    // 读取土壤湿度原始 ADC 值
  int smoothVal = smoothADC(rawADC);                     // 经滑动平均滤波后的 ADC 值
  g_percent = map(smoothVal, ADC_DRY, ADC_WET, 0, 100);  // 把 ADC 映射到湿度百分比(0~100)
  g_percent = constrain(g_percent, 0, 100);              // 限幅到 0~100

  g_airHum  = dht.readHumidity();                        // 读取空气湿度
  g_airTemp = dht.readTemperature();                     // 读取空气温度
  g_dhtOk   = !isnan(g_airHum) && !isnan(g_airTemp);     // 校验 DHT 读数是否有效

  g_soilTemp = readSoilTemp();                           // 读取土壤温度
  g_dsOk = (g_soilTemp != DEVICE_DISCONNECTED_C && g_soilTemp != 85.0);  // 校验 DS18B20 读数是否有效

  ensureMqtt();                                          // 维护 MQTT 连接（断则重连）
  digitalWrite(LED_PIN, WiFi.status() == WL_CONNECTED ? HIGH : LOW);  // WiFi 连通则点亮板载 LED

  Serial.printf("[%lu] 土壤湿度:%d%%(raw=%d smooth=%d ADC_DRY=%d/ADC_WET=%d) 土壤温度:%.1f℃ 空气湿度:%s%% 空气温度:%s℃ 灌溉:%s\n",
                millis(), g_percent, rawADC, smoothVal, ADC_DRY, ADC_WET,
                g_dsOk ? g_soilTemp : -99.0,
                g_dhtOk ? String((int)g_airHum).c_str() : "--",
                g_dhtOk ? String(g_airTemp, 1).c_str() : "--",
                irrigationActive ? "ON" : "OFF");   // 串口打印各监测值（RSSI 在 JSON rssi 字段，仍上传）

  // 5 档墒情等级先按当前帧真实湿度刷新（必须在告警判定之前！）
  // ⚠️ 之前这行放在告警判定之后，导致报警永远滞后一帧：
  //    OLED 已显示"适宜"，蜂鸣器却还在响上一帧的"轻旱/过湿"，造成"适宜还响"的错觉
  g_soilLevel = judgeSoilMoisture(g_percent);            // 用当前湿度刷新墒情等级

  // 墒情告警：与 judgeSoilMoisture 共用一套阈值
  // 重旱/积水 → 800ms 长响(严重);轻旱/过湿 → 300ms 短响(提示);适宜 → 静默
  String lv = String(g_soilLevel);                       // 当前等级转字符串
  if (lv == "重旱" || lv == "积水") {                    // 严重等级
    tryBuzzer(800);                                      // 长响报警(800ms)
  } else if (lv == "轻旱" || lv == "过湿") {             // 提示等级
    tryBuzzer(300);                                      // 短响提示(300ms)
  }
  // 适宜 → 本地蜂鸣静默（仅硬件报警）

  // 巴法云微信告警推送：状态变化立刻推 + 同一状态每 minGap 推一次
  // 满足任一即推：①等级发生变化（首次越限或异常类型升级）→立即推
  //                ②同一异常等级停留时间 >= minGap（默认 3min）→周期复推
  // minGap：上次推送成功用 WECHAT_ALERT_MIN_MS (3min)；失败则 1min 后重试
  if (lv != "适宜") {                                     // 异常等级才推送微信
    unsigned long gap = millis() - lastWechatAlertMs;    // 距上次推送的时长
    unsigned long minGap = g_lastWechatOk ? WECHAT_ALERT_MIN_MS : 60000UL;  // 推送最小间隔
    bool stateChanged = (lv != g_lastAlertLevel);        // 等级是否发生变化
    if (stateChanged || gap > minGap) {                  // 变化或超时间隔则推送
      String alertMsg;                                    // 告警文案（自带"墒情告警："前缀，整条作为通知卡片标题）
      if      (lv == "重旱") alertMsg = "墒情告警：土壤湿度仅" + String(g_percent) + "%【重旱】，请尽快灌溉！";  // 重旱文案
      else if (lv == "轻旱") alertMsg = "墒情告警：土壤湿度" + String(g_percent) + "%【轻旱】，建议近期灌溉";     // 轻旱文案
      else if (lv == "过湿") alertMsg = "墒情告警：土壤湿度" + String(g_percent) + "%【过湿】，建议通风控水";     // 过湿文案
      else if (lv == "积水") alertMsg = "墒情告警：土壤湿度" + String(g_percent) + "%【积水】，请排水防涝！";     // 积水文案
      g_lastWechatOk = pushWechatAlert(alertMsg);         // 推送微信告警
      lastWechatAlertMs = millis();                       // 记录本次推送时刻
      if (g_lastWechatOk) g_lastAlertLevel = lv;          // 成功才记录状态；失败 1min 后重试
    }
  } else {
    g_lastAlertLevel = "适宜";   // 恢复正常 → 重置，下次异常重新推送
  }

  // 自动灌溉启动 / 关闭
  tryAutoIrrigate();                                       // 尝试自动灌溉（满足条件则开）
  // 自动灌溉结束：① 湿度已达目标(进入适宜区)→ 提前暂停，省水省电；
  //             ② 超过单次最大时长 → 强制停（兜底）
  bool reachedTarget = (g_percent >= irr.shStop);         // 湿度是否已达目标停灌值
  if (irrigationActive && (reachedTarget || millis() - lastIrrigationStart >= irr.pulseMs)) {  // 达目标或超时长则停
    digitalWrite(RELAY_PIN, RELAY_OFF);                   // 关继电器，停止灌溉
    irrigationActive = false;                             // 标记灌溉停止
    String done = reachedTarget ? ("湿度已达适宜 " + String(g_percent) + "%")
                                : ("持续" + String(irr.pulseMs / 1000) + "s");  // 完成原因文案
    Serial.println("[灌溉] 完成");
  }

  // OLED + 上报
  drawOLED(mqtt.connected());                             // 刷新 OLED 显示

  // 蜂鸣器统一驱动：自动阈值告警(g_buzzUntil) 与 测试报警(g_testBuzzUntil)
  // 用“或”合并，互不冲突、互不影响；任一到期即停。
  updateBuzzer();                                         // 统一驱动蜂鸣器引脚

  if (mqtt.connected() && millis() - lastReportMs > REPORT_INTERVAL) {  // 到达上报间隔
    reportData();                                         // 执行数据上报
    lastReportMs = millis();                              // 记录上报时刻
  }

  // 默认 WDT 由系统管理，无需手动 reset
  unsigned long ms = millis();                            // 记录循环起始时刻
  while (millis() - ms < 1000) {                          // 约 1 秒节拍（喂狗 + 处理 MQTT）
    mqtt.loop();                                          // 处理 MQTT 收发
    delay(10);                                            // 小延时，让出 CPU
  }
}
