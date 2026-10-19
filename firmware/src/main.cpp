// Applicazione utente. Questo file puo' essere sostituito dalla dashboard (Compila & Aggiorna).
// REGOLA: deve sempre chiamare iot::begin(), altrimenti si perde il controllo remoto/OTA.
#include <Arduino.h>
#include "IotCore.h"

static constexpr uint8_t LED_PIN = 2;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  // Campi custom aggiunti alla telemetria (eseguito nel task di rete)
  iot::onTelemetry([](JsonObject out) {
    out["hall"] = hallRead();
  });

  iot::onSettingsChanged([](const iot::Settings& s) {
    Serial.printf("[app] config: interval=%us offset=%.1f led=%d\n", s.intervalS, s.tempOffsetC, s.led);
  });

  iot::begin();
}

void loop() {
  static uint32_t last = 0;
  static bool on = false;
  if (!iot::settings().led) {
    digitalWrite(LED_PIN, LOW);
  } else if (millis() - last >= 500) {
    last = millis();
    on = !on;
    digitalWrite(LED_PIN, on);
  }
  delay(10);
}
