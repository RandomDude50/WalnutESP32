#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>
#include <functional>

// IotCore: Wi-Fi + MQTT (riconnessione automatica in un task FreeRTOS dedicato),
// configurazione dinamica persistita in NVS, telemetria periodica, OTA via HTTP(S).
//
// Il codice utente (src/main.cpp) deve chiamare iot::begin(): il backend rifiuta
// sorgenti che non lo fanno, altrimenti il dispositivo perderebbe l'OTA remoto.
//
// ATTENZIONE: gli hook vengono eseguiti nel task di rete (core 0), non in loop().

namespace iot {

struct Settings {
  uint32_t intervalS   = 5;     // periodo telemetria [1..3600] s
  float    tempOffsetC = 0.0f;  // calibrazione temperatura
  bool     led         = true;  // a disposizione dell'applicazione
};

using TelemetryHook = std::function<void(JsonObject)>;
using SettingsHook  = std::function<void(const Settings&)>;

void begin();
void onTelemetry(TelemetryHook cb);        // aggiungi campi custom al JSON di telemetria
void onSettingsChanged(SettingsHook cb);   // chiamato dopo ogni config ricevuta via MQTT
Settings settings();                       // copia thread-safe
String   deviceId();                       // "esp32-AABBCC" dagli ultimi 3 byte del MAC
bool     connected();                      // true se MQTT connesso

}  // namespace iot
