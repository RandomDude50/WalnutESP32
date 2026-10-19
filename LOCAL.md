# Modalità locale (PC + ESP32 sulla stessa Wi-Fi)

Stesso codice e stesso protocollo MQTT della versione cloud, ma senza Docker, Mosquitto, Caddy o TLS:
il backend avvia da solo un **broker MQTT integrato** (aedes) e serve la dashboard.

```
ESP32 ──MQTT :1883──► [ PC: broker integrato + backend + pio ] ◄──HTTP :3000── browser (PC o telefono)
  ▲                                  │
  └────── HTTP :3000/firmware/<job>.bin (OTA) ◄──┘
```

## Requisiti sul PC
Node.js ≥ 20.6, [PlatformIO CLI](https://platformio.org/install/cli) (`pio --version` deve funzionare), PC ed ESP32 sulla stessa rete Wi-Fi 2.4 GHz.

## Avvio (una tantum + ogni volta)

```bash
npm run local:setup      # chiede IP del PC e token; scrive .env.local (nessun secrets.h su disco)
npm run local:build      # installa le dipendenze e compila la dashboard
npm run local            # avvia broker + backend; stampa URL e token (lascia in esecuzione)
npm run local:flash      # (o 'cd firmware && pio run -t upload') chiede SSID/password e prende il resto dalla web app
```

Apri l'URL stampato (es. `http://192.168.1.50:3000`, token predefinito `local`) dal PC o dal telefono.
La prima compilazione da dashboard scarica toolchain ESP32 e librerie (alcuni minuti); le successive sono veloci.

## Se qualcosa non va
- **L'ESP32 non compare**: firewall del PC. Consenti connessioni in ingresso su TCP **1883** (MQTT) e **3000** (dashboard/OTA). Controlla anche che l'IP del PC non sia cambiato (DHCP): se cambia, rilancia `local:setup` e rifai la flash USB. Consiglio: riserva l'IP del PC nel router.
- **Porta 1883 occupata**: hai già un Mosquitto locale. Avvia con `LOCAL_BROKER=0 MQTT_URL=mqtt://127.0.0.1:1883`.
- **OTA fallisce con HTTP error**: l'ESP32 deve raggiungere `PUBLIC_URL` (in `.env.local`); client isolation sul router (AP isolation / "guest network") lo impedisce.
- **Sicurezza**: broker anonimo e token semplice vanno bene solo su LAN domestica fidata. Non esporre le porte su Internet.

## Passare al cloud (o alla mesh) dopo
Cambia solo la configurazione, non il codice:

| Cosa | Locale | Cloud |
|---|---|---|
| Broker | integrato nel backend | Mosquitto (`docker-compose.yml`) con utenti, ACL, TLS |
| Backend | `npm run local` (`MODE=local`) | container Docker (README.md) |
| Host MQTT nel firmware | IP del PC | dominio pubblico (`DEVICE_MQTT_HOST`) |

**Rete mesh**: i topic sono già per-dispositivo (`iot/<id>/...`). Con ESP-MESH/painlessMesh/ESP-NOW basta che un nodo *gateway* (root della mesh) faccia da ponte verso MQTT pubblicando e sottoscrivendo gli stessi topic a nome dei nodi interni: backend e dashboard non cambiano. L'unica parte da adattare è l'OTA dei nodi non-root (il gateway scarica il `.bin` e lo inoltra), da fare in un secondo momento.
