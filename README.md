# ESP32 Cloud IoT

Sistema completo: firmware ESP32 (PlatformIO) · broker MQTT (Mosquitto) · backend Node.js (Express, mqtt.js, WebSocket, compilazione PlatformIO) · dashboard React.

```
┌─────────┐  MQTT   ┌───────────┐  MQTT   ┌──────────────────────┐  WS+REST  ┌───────────┐
│  ESP32  │◄───────►│ Mosquitto │◄───────►│ Backend Node/Express │◄─────────►│ React app │
└────┬────┘         └───────────┘         │  └ pio run (compila) │           └───────────┘
     │   HTTP(S) GET /firmware/<job>.bin?t=<token>  └ serve .bin  │
     └──────────────────────────────────────────────┴─────────────┘
```

## Topic MQTT (`<id>` = `esp32-AABBCC`, ultimi 3 byte del MAC)

| Topic | Direzione | Payload |
|---|---|---|
| `iot/<id>/telemetry` | dev → cloud | `{uptime_s,temp_c,heap_free,heap_min,rssi,fw,interval_s,...}` |
| `iot/<id>/status` | dev → cloud (retained + LWT) | `{online,fw,ip}` |
| `iot/<id>/config/set` | cloud → dev | `{interval_s?,temp_offset_c?,led?}` |
| `iot/<id>/config/state` | dev → cloud (retained) | stato reale dopo l'applicazione |
| `iot/<id>/cmd/ota` | cloud → dev | `{job_id,url,md5,size}` |
| `iot/<id>/cmd/reboot` | cloud → dev | `{}` |
| `iot/<id>/ota/status` | dev → cloud | `{state: downloading\|success\|failed, progress, job_id, error}` |

## Flusso OTA da sorgente

1. La dashboard invia `POST /api/compile-and-flash {deviceId, code, flash}`.
2. Il backend valida il sorgente, copia il template firmware in una dir temporanea per-job, sostituisce **solo** `src/main.cpp`, passa la configurazione e `FW_VERSION=<jobId>` tramite macro/variabili d'ambiente al build ed esegue `pio run`.
3. Il `.bin` viene salvato con MD5 e token monouso; il backend pubblica `cmd/ota`.
4. L'ESP32 scarica via HTTP(S), verifica MD5 (`Update.h`), riavvia.
5. Il job passa a `done` quando il dispositivo ritorna online con `fw == jobId`.

`IotCore` (Wi-Fi, MQTT, NVS, OTA) resta nel template e non viene mai sostituito: l'utente modifica solo `main.cpp`, che **deve** chiamare `iot::begin()` (il backend rifiuta sorgenti che non lo fanno).

## Deployment su VPS con Docker

```bash
cp .env.example .env            # compila DOMAIN, PUBLIC_URL, API_TOKEN, Wi-Fi, credenziali MQTT

# utenti Mosquitto (backend + device)
docker run --rm -it -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto \
  mosquitto_passwd -c /mosquitto/config/passwd backend
docker run --rm -it -v "$PWD/mosquitto:/mosquitto/config" eclipse-mosquitto \
  mosquitto_passwd /mosquitto/config/passwd device
chmod 0700 mosquitto/passwd

docker compose up -d --build    # il primo build scarica toolchain ESP32 (~1 GB), poi e' in cache
```

Apri `https://<DOMAIN>` (Caddy gestisce il certificato) e accedi con `API_TOKEN`.
Apri le porte 80, 443 e 1883 (o 8883 con TLS) sul firewall.

## Prima flash via USB (una sola volta)

```bash
cd firmware
pio run -t upload && pio device monitor
```

Durante il flash PlatformIO richiederà interattivamente i dati Wi-Fi (`WIFI_SSID`, `WIFI_PASS`) e preleverà automaticamente i parametri del broker dalla web app. Nessun file `secrets.h` con credenziali in chiaro viene memorizzato su disco.

Da qui in poi tutti gli aggiornamenti passano dalla dashboard.

## Sviluppo locale

```bash
cd backend && npm install && API_TOKEN=dev PUBLIC_URL=http://<ip-lan>:3000 \
  MQTT_URL=mqtt://localhost:1883 WIFI_SSID=x DEVICE_MQTT_HOST=<ip-lan> DEVICE_MQTT_USER=device DEVICE_MQTT_PASS=x \
  npm run dev          # richiede `pio` nel PATH
cd frontend && npm install && npm run dev   # http://localhost:5173
```

## Note di sicurezza e robustezza (leggere prima della produzione)

- **Compilare codice C++ di terzi e' esecuzione su input non fidato.** Il compose limita memoria/CPU/PID, rimuove le capability e usa un utente non-root; il processo `pio` riceve un ambiente senza segreti; `platformio.ini` e' del template (l'utente non puo' aggiungere `extra_scripts` o `lib_deps`); gli `#include` con path assoluti/`..` sono bloccati. Esponi la dashboard solo a utenti fidati: `API_TOKEN` equivale a privilegi di amministratore. Per multiutente reale servono sandbox per-job (gVisor/Firecracker) e egress di rete limitato.
- **TLS**: abilita Mosquitto su 8883 e `DEVICE_MQTT_TLS=1`. Senza `MQTT_CA_CERT` il firmware usa `setInsecure()` (cifra ma non autentica il server): definisci `MQTT_CA_CERT` per la produzione. Lo stesso vale per il download OTA https (qui protetto da MD5 + token monouso).
- **Rischio brick logico**: un `main.cpp` funzionante ma con bug (watchdog, crash prima di `iot::begin()`) richiede ri-flash USB. Mitigazione consigliata: abilitare l'app rollback di ESP-IDF (`CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE`, non disponibile nel core Arduino precompilato senza ricompilarlo) oppure testare prima su un dispositivo di prova.
- **Dati**: stato e storico sono in memoria nel backend (si azzerano al riavvio). Per persistenza aggiungi un DB time-series (InfluxDB/TimescaleDB).
- **SSID/password con caratteri speciali** vengono serializzati con `JSON.stringify` nel literal C; evita caratteri non ASCII/controllo.
- Il token WebSocket e' nella query string: assicurati che il reverse proxy non logghi gli URL completi.

> Per provarlo subito su una sola rete locale senza Docker: vedi [LOCAL.md](LOCAL.md).
