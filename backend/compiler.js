import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';

export class CompileError extends Error {}

const cstr = (s) => JSON.stringify(String(s)); // literal C valido per stringhe ASCII/UTF-8 semplici

/** Validazione statica minima. L'isolamento vero e' il container (vedi README). */
export function validateSource(code) {
  if (typeof code !== 'string' || !code.trim()) return 'Sorgente vuoto';
  if (Buffer.byteLength(code) > cfg.maxSourceBytes) return 'Sorgente troppo grande (max 256 KB)';
  if (/#\s*(include_next|embed)\b/.test(code)) return 'Direttiva non consentita';
  if (/#\s*include\s*["<]\s*(\/|[A-Za-z]:|[^">]*\.\.)/.test(code))
    return '#include con path assoluto o con ".." non consentito';
  if (!/\biot::begin\s*\(/.test(code))
    return 'Il sorgente deve chiamare iot::begin(): senza, il dispositivo perderebbe MQTT e OTA';
  return null;
}

function run(cmd, args, { cwd, env, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } // Windows: niente process group
    }, timeoutMs);
    const feed = (buf) => buf.toString().split(/\r?\n/).filter(Boolean).forEach(onLine);
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); onLine(String(e)); resolve({ code: -1, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}

/**
 * Compila `code` come src/main.cpp del template firmware in una directory temporanea
 * per-job. Restituisce { md5, size }; il .bin finisce in cfg.artifactDir/<jobId>.bin.
 */
export async function compile({ jobId, code, onLog }) {
  const err = validateSource(code);
  if (err) throw new CompileError(err);

  const jobDir = path.join(cfg.workDir, jobId);
  await fs.mkdir(cfg.workDir, { recursive: true });
  await fs.mkdir(cfg.artifactDir, { recursive: true });

  try {
    await fs.cp(cfg.templateDir, jobDir, {
      recursive: true,
      filter: (s) => !/[\\/]\.pio([\\/]|$)/.test(s) && !/[\\/]secrets\.h$/.test(s),
    });
    // L'utente sostituisce SOLO main.cpp: IotCore e platformio.ini restano quelli del template.
    const src = code.includes('Arduino.h') ? code : `#include <Arduino.h>\n${code}`;
    await fs.writeFile(path.join(jobDir, 'src', 'main.cpp'), src);

    const d = cfg.device;
    const env = {
      ...(cfg.local
        ? process.env
        : {
            PATH: process.env.PATH,
            HOME: process.env.HOME || '/tmp',
            ...(cfg.pioCoreDir ? { PLATFORMIO_CORE_DIR: cfg.pioCoreDir } : {}),
          }),
      PLATFORMIO_SETTING_ENABLE_TELEMETRY: 'no',
      IOT_JOB_ID: jobId,
      IOT_WIFI_SSID: d.wifiSsid,
      IOT_WIFI_PASS: d.wifiPass,
      IOT_MQTT_HOST: d.mqttHost,
      IOT_MQTT_PORT: String(d.mqttPort),
      IOT_MQTT_USER: d.mqttUser || '',
      IOT_MQTT_PASS: d.mqttPass || '',
      IOT_MQTT_TLS: d.mqttTls ? '1' : '0',
    };
    const res = await run(cfg.pioBin, ['run', '-d', jobDir, '-e', 'esp32dev'], {
      cwd: jobDir, env, timeoutMs: cfg.compileTimeoutMs, onLine: onLog,
    });
    if (res.timedOut) throw new CompileError('Timeout di compilazione');
    if (res.code !== 0) throw new CompileError('Compilazione fallita (vedi log)');

    const data = await fs.readFile(path.join(jobDir, '.pio', 'build', 'esp32dev', 'firmware.bin'));
    const md5 = crypto.createHash('md5').update(data).digest('hex');
    await fs.writeFile(path.join(cfg.artifactDir, `${jobId}.bin`), data);
    return { md5, size: data.length };
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true });
  }
}
