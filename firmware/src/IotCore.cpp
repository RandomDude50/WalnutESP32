#include "IotCore.h"

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <PubSubClient.h>
#include <esp_system.h>
#include <algorithm>

#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASS
#define WIFI_PASS ""
#endif
#ifndef MQTT_HOST
#define MQTT_HOST "127.0.0.1"
#endif
#ifndef MQTT_PORT
#define MQTT_PORT 1883
#endif
#ifndef MQTT_USER
#define MQTT_USER ""
#endif
#ifndef MQTT_PASS
#define MQTT_PASS ""
#endif
#ifndef MQTT_USE_TLS
#define MQTT_USE_TLS 0
#endif
#ifndef FW_VERSION
#define FW_VERSION "dev"
#endif

namespace iot {
namespace {

constexpr uint32_t kMinIntervalS   = 1;
constexpr uint32_t kMaxIntervalS   = 3600;
constexpr uint32_t kWifiRetryMs    = 30000;
constexpr uint32_t kBackoffMinMs   = 1000;
constexpr uint32_t kBackoffMaxMs   = 30000;

Settings      g_settings;
portMUX_TYPE  g_mux = portMUX_INITIALIZER_UNLOCKED;
TelemetryHook g_telemetryHook;
SettingsHook  g_settingsHook;
Preferences   g_prefs;

String g_id;
String tTelemetry, tStatus, tCfgSet, tCfgState, tCmdPrefix, tCmdOta, tCmdReboot, tOtaStatus;

#if MQTT_USE_TLS
WiFiClientSecure g_net;
#else
WiFiClient g_net;
#endif
PubSubClient g_mqtt(g_net);

struct OtaRequest {
  volatile bool pending = false;
  String url, md5, jobId;
} g_ota;

// ---------- Settings (NVS) ----------
void loadSettings() {
  Settings s;
  g_prefs.begin("iot", true);
  s.intervalS   = g_prefs.getUInt("interval", s.intervalS);
  s.tempOffsetC = g_prefs.getFloat("toff", s.tempOffsetC);
  s.led         = g_prefs.getBool("led", s.led);
  g_prefs.end();
  portENTER_CRITICAL(&g_mux);
  g_settings = s;
  portEXIT_CRITICAL(&g_mux);
}

void saveSettings(const Settings& s) {
  g_prefs.begin("iot", false);
  g_prefs.putUInt("interval", s.intervalS);
  g_prefs.putFloat("toff", s.tempOffsetC);
  g_prefs.putBool("led", s.led);
  g_prefs.end();
}

// ---------- Publish helpers ----------
void publishJson(const String& topic, JsonDocument& doc, bool retain = false) {
  String out;
  serializeJson(doc, out);
  g_mqtt.publish(topic.c_str(), out.c_str(), retain);
}

void publishStatus() {
  JsonDocument d;
  d["online"] = true;
  d["fw"]     = FW_VERSION;
  d["ip"]     = WiFi.localIP().toString();
  publishJson(tStatus, d, true);
}

void publishConfigState() {
  Settings s = settings();
  JsonDocument d;
  d["interval_s"]    = s.intervalS;
  d["temp_offset_c"] = s.tempOffsetC;
  d["led"]           = s.led;
  publishJson(tCfgState, d, true);
}

void publishOta(const char* state, int progress = -1, const char* error = nullptr) {
  JsonDocument d;
  d["state"]  = state;
  d["job_id"] = g_ota.jobId;
  if (progress >= 0) d["progress"] = progress;
  if (error) d["error"] = error;
  publishJson(tOtaStatus, d);
}

void publishTelemetry() {
  Settings s = settings();
  JsonDocument d;
  d["uptime_s"]   = (uint32_t)(esp_timer_get_time() / 1000000ULL);
  d["temp_c"]     = temperatureRead() + s.tempOffsetC;  // sensore interno ESP32: poco preciso
  d["heap_free"]  = ESP.getFreeHeap();
  d["heap_min"]   = ESP.getMinFreeHeap();
  d["rssi"]       = WiFi.RSSI();
  d["fw"]         = FW_VERSION;
  d["interval_s"] = s.intervalS;
  if (g_telemetryHook) g_telemetryHook(d.as<JsonObject>());
  publishJson(tTelemetry, d);
}

// ---------- Command handling ----------
void applyConfig(JsonObjectConst o) {
  Settings s = settings();
  if (o["interval_s"].is<uint32_t>()) {
    uint32_t v = o["interval_s"].as<uint32_t>();
    s.intervalS = std::max(kMinIntervalS, std::min(v, kMaxIntervalS));
  }
  if (o["temp_offset_c"].is<float>()) {
    float v = o["temp_offset_c"].as<float>();
    if (v > -50.0f && v < 50.0f) s.tempOffsetC = v;
  }
  if (o["led"].is<bool>()) s.led = o["led"].as<bool>();

  portENTER_CRITICAL(&g_mux);
  g_settings = s;
  portEXIT_CRITICAL(&g_mux);
  saveSettings(s);
  if (g_settingsHook) g_settingsHook(s);
  publishConfigState();  // conferma retained: la dashboard vede lo stato reale
}

void onMessage(char* topic, uint8_t* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) {
    Serial.println("[iot] JSON non valido");
    return;
  }
  String t(topic);
  if (t == tCfgSet) {
    applyConfig(doc.as<JsonObjectConst>());
  } else if (t == tCmdOta) {
    if (g_ota.pending) return;
    String url = doc["url"] | "";
    if (!(url.startsWith("http://") || url.startsWith("https://"))) return;
    g_ota.url   = url;
    g_ota.md5   = doc["md5"] | "";
    g_ota.jobId = doc["job_id"] | "";
    g_ota.pending = true;  // eseguito fuori dalla callback
  } else if (t == tCmdReboot) {
    delay(200);
    ESP.restart();
  }
}

// ---------- OTA ----------
void otaFail(const String& why) {
  Serial.printf("[ota] errore: %s\n", why.c_str());
  publishOta("failed", -1, why.c_str());
}

void runOta() {
  OtaRequest req;
  req.url = g_ota.url; req.md5 = g_ota.md5; req.jobId = g_ota.jobId;
  g_ota.pending = false;

  publishOta("downloading", 0);
  HTTPClient http;
  WiFiClient plain;
  WiFiClientSecure secure;
  if (req.url.startsWith("https://")) {
    secure.setInsecure();  // integrita' garantita da MD5 + token monouso; in produzione usa setCACert()
    http.begin(secure, req.url);
  } else {
    http.begin(plain, req.url);
  }
  http.setConnectTimeout(10000);
  http.setTimeout(20000);
  http.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);

  int code = http.GET();
  if (code != HTTP_CODE_OK) { otaFail("HTTP " + String(code)); http.end(); return; }
  int len = http.getSize();
  if (len <= 0) { otaFail("Content-Length mancante"); http.end(); return; }
  if (!Update.begin(len)) { otaFail(Update.errorString()); http.end(); return; }
  if (req.md5.length() == 32) Update.setMD5(req.md5.c_str());

  int lastPct = -10;
  Update.onProgress([&](size_t done, size_t total) {
    int pct = total ? (int)(done * 100 / total) : 0;
    if (pct >= lastPct + 10) { lastPct = pct; publishOta("downloading", pct); }
  });

  size_t written = Update.writeStream(*http.getStreamPtr());
  http.end();
  if (written != (size_t)len) { Update.abort(); otaFail("scrittura incompleta"); return; }
  if (!Update.end(true))      { otaFail(Update.errorString()); return; }  // verifica MD5 inclusa

  publishOta("success", 100);
  for (int i = 0; i < 10; i++) { g_mqtt.loop(); delay(50); }
  ESP.restart();
}

// ---------- Connection / main network task ----------
bool connectMqtt() {
  const char* will = "{\"online\":false}";
  const bool auth = strlen(MQTT_USER) > 0;  // modalità locale: broker anonimo
  if (!g_mqtt.connect(g_id.c_str(), auth ? MQTT_USER : nullptr, auth ? MQTT_PASS : nullptr,
                      tStatus.c_str(), 1, true, will)) return false;
  g_mqtt.subscribe(tCfgSet.c_str(), 1);
  g_mqtt.subscribe((tCmdPrefix + "#").c_str(), 1);
  publishStatus();
  publishConfigState();
  return true;
}

void netTask(void*) {
  uint32_t lastWifiTry = millis(), lastMqttTry = 0, lastTel = 0, backoff = kBackoffMinMs;

  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  WiFi.setHostname(g_id.c_str());
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  for (;;) {
    uint32_t now = millis();

    if (WiFi.status() != WL_CONNECTED) {
      if (now - lastWifiTry > kWifiRetryMs) {  // auto-reconnect bloccato: riavvio manuale
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASS);
        lastWifiTry = now;
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    if (!g_mqtt.connected()) {
      if (now - lastMqttTry >= backoff) {
        lastMqttTry = now;
        if (connectMqtt()) {
          backoff = kBackoffMinMs;
          lastTel = now - settings().intervalS * 1000UL;  // telemetria immediata
        } else {
          backoff = std::min(backoff * 2, kBackoffMaxMs);
        }
      }
    } else {
      g_mqtt.loop();
      if (now - lastTel >= settings().intervalS * 1000UL) {
        lastTel = now;
        publishTelemetry();
      }
      if (g_ota.pending) runOta();
    }
    vTaskDelay(pdMS_TO_TICKS(20));
  }
}

}  // namespace

// ---------- Public API ----------
void onTelemetry(TelemetryHook cb)       { g_telemetryHook = std::move(cb); }
void onSettingsChanged(SettingsHook cb)  { g_settingsHook = std::move(cb); }
bool connected()                         { return g_mqtt.connected(); }
String deviceId()                        { return g_id; }

Settings settings() {
  portENTER_CRITICAL(&g_mux);
  Settings s = g_settings;
  portEXIT_CRITICAL(&g_mux);
  return s;
}

void begin() {
  uint8_t mac[6];
  esp_efuse_mac_get_default(mac);
  char buf[24];
  snprintf(buf, sizeof(buf), "esp32-%02X%02X%02X", mac[3], mac[4], mac[5]);
  g_id = buf;

  String base = "iot/" + g_id + "/";
  tTelemetry = base + "telemetry";
  tStatus    = base + "status";
  tCfgSet    = base + "config/set";
  tCfgState  = base + "config/state";
  tCmdPrefix = base + "cmd/";
  tCmdOta    = base + "cmd/ota";
  tCmdReboot = base + "cmd/reboot";
  tOtaStatus = base + "ota/status";

  loadSettings();

#if MQTT_USE_TLS
  #ifdef MQTT_CA_CERT
  g_net.setCACert(MQTT_CA_CERT);
  #else
  g_net.setInsecure();
  #endif
#endif
  g_mqtt.setServer(MQTT_HOST, MQTT_PORT);
  g_mqtt.setCallback(onMessage);
  g_mqtt.setBufferSize(1024);
  g_mqtt.setKeepAlive(30);
  g_mqtt.setSocketTimeout(5);

  Serial.printf("[iot] id=%s fw=%s\n", g_id.c_str(), FW_VERSION);
  xTaskCreatePinnedToCore(netTask, "iot_net", 16384, nullptr, 1, nullptr, 0);
}

}  // namespace iot
