// Configurazione guidata della modalità locale.
// Uso: node scripts/setup-local.mjs [--ssid X] [--pass Y] [--ip 192.168.1.50] [--token T]
// Scrive .env.local (per il backend). Nessun file secrets.h viene creato.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { lanIp } from '../backend/net.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = async (key, label, def = '') => {
  if (args[key] !== undefined) return args[key];
  const a = (await rl.question(`${label}${def ? ` [${def}]` : ''}: `)).trim();
  return a || def;
};

const ip = await ask('ip', 'IP di questo PC sulla LAN', lanIp());
const token = await ask('token', 'Token di accesso alla dashboard', 'local');
const ssid = await ask('ssid', 'SSID Wi-Fi predefinito (2.4 GHz) [opzionale, suggerito al flash]', '');
const pass = ssid ? await ask('pass', 'Password Wi-Fi predefinita [opzionale]', '') : '';
rl.close();

if (/["\\\n\r]/.test(ssid + pass)) { console.error('SSID/password con virgolette, backslash o a capo non supportati'); process.exit(1); }

fs.writeFileSync(path.join(root, '.env.local'), `MODE=local
API_TOKEN=${token}
WIFI_SSID=${ssid}
WIFI_PASS=${pass}
DEVICE_MQTT_HOST=${ip}
PUBLIC_URL=http://${ip}:3000
`);

console.log(`\nFatto. PC: ${ip}\n  .env.local creato.\n  Nessun file secrets.h generato: le credenziali per l'ESP32 verranno chieste al momento del flash USB (pio run -t upload) e gli altri parametri verranno presi in automatico dalla web app.\nProssimi passi: vedi LOCAL.md (npm run local:build, npm run local)`);

