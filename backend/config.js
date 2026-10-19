import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { lanIp } from './net.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// MODE=local: tutto sulla stessa rete, broker MQTT integrato, nessun TLS, token di default.
// Qualsiasi variabile puo' comunque essere sovrascritta da env/.env.local.
export const local = process.env.MODE === 'local';
const ip = local ? lanIp() : '';
const port = Number(process.env.PORT) || 3000;
const brokerPort = Number(process.env.LOCAL_BROKER_PORT) || 1883;

const get = (k, localDefault) => {
  if (process.env[k]) return process.env[k];
  if (local && localDefault !== undefined) return localDefault;
  throw new Error(`Variabile d'ambiente mancante: ${k}`);
};

export const cfg = {
  local,
  port,
  apiToken: get('API_TOKEN', 'local'),
  // URL raggiungibile dall'ESP32 da cui scaricare il .bin
  publicUrl: get('PUBLIC_URL', `http://${ip}:${port}`).replace(/\/$/, ''),

  localBroker: local && process.env.LOCAL_BROKER !== '0',
  localBrokerPort: brokerPort,

  // Connessione del backend al broker
  mqtt: {
    url: get('MQTT_URL', `mqtt://127.0.0.1:${brokerPort}`),
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
  },

  // Parametri incorporati nel firmware durante la compilazione (passati come macro o via script)
  device: {
    wifiSsid: get('WIFI_SSID', ''),
    wifiPass: process.env.WIFI_PASS ?? '',
    mqttHost: get('DEVICE_MQTT_HOST', ip),
    mqttPort: Number(process.env.DEVICE_MQTT_PORT) || (local ? brokerPort : 1883),
    mqttTls: process.env.DEVICE_MQTT_TLS === '1',
    mqttUser: local ? process.env.DEVICE_MQTT_USER ?? '' : get('DEVICE_MQTT_USER', ''),
    mqttPass: local ? process.env.DEVICE_MQTT_PASS ?? '' : get('DEVICE_MQTT_PASS', ''),
  },

  templateDir: path.resolve(process.env.TEMPLATE_DIR || path.join(root, 'firmware')),
  workDir: path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'iot-jobs')),
  artifactDir: path.resolve(process.env.ARTIFACT_DIR || path.join(os.tmpdir(), 'iot-artifacts')),
  staticDir: path.resolve(process.env.STATIC_DIR || path.join(root, 'frontend', 'dist')),
  pioBin: process.env.PIO_BIN || 'pio',
  pioCoreDir: process.env.PLATFORMIO_CORE_DIR || '',
  compileTimeoutMs: Number(process.env.COMPILE_TIMEOUT_MS) || 10 * 60 * 1000,
  otaTimeoutMs: Number(process.env.OTA_TIMEOUT_MS) || 3 * 60 * 1000,
  maxSourceBytes: 256 * 1024,
  maxQueuedJobs: 3,
  keepJobs: 20,
};
