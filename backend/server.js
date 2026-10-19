import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { WebSocketServer } from 'ws';
import { cfg } from './config.js';
import { compile, validateSource } from './compiler.js';
import { startLocalBroker } from './local-broker.js';

const ID_RE = /^[A-Za-z0-9_-]{3,32}$/;
const HISTORY = 120;
const ACTIVE_OTA = ['ota-requested', 'ota-downloading', 'ota-installed'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// ---------------------------------------------------------------- stato
const devices = new Map();
const jobs = new Map();

function dev(id) {
  if (!devices.has(id)) {
    devices.set(id, { id, online: false, lastSeen: null, telemetry: null, history: [], config: null, fw: null, ip: null, ota: null });
  }
  return devices.get(id);
}
const publicDevice = (d, withHistory = false) => {
  const { history, ...rest } = d;
  return withHistory ? { ...rest, history } : rest;
};
const publicJob = (j, withLog = false) => {
  const { fwToken, otaTimer, log, ...rest } = j;
  return withLog ? { ...rest, log } : rest;
};

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ noServer: true });
const broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
};

function setJob(job, patch) {
  Object.assign(job, patch);
  if (['done', 'failed'].includes(job.state) && job.otaTimer) {
    clearTimeout(job.otaTimer);
    job.otaTimer = null;
  }
  broadcast({ type: 'job', job: publicJob(job) });
}
function pushLog(job, line) {
  job.log.push(line);
  if (job.log.length > 300) job.log.shift();
  broadcast({ type: 'joblog', id: job.id, line });
}

// ---------------------------------------------------------------- MQTT
if (cfg.localBroker) startLocalBroker(cfg.localBrokerPort);
const client = mqtt.connect(cfg.mqtt.url, {
  username: cfg.mqtt.username,
  password: cfg.mqtt.password,
  clientId: `backend-${crypto.randomBytes(4).toString('hex')}`,
  reconnectPeriod: 2000,
});
client.on('connect', () => {
  console.log('[mqtt] connesso al broker');
  client.subscribe(['iot/+/telemetry', 'iot/+/status', 'iot/+/config/state', 'iot/+/ota/status'], { qos: 1 });
});
client.on('error', (e) => console.error('[mqtt]', e.message));

client.on('message', (topic, payload) => {
  const [, id, ...rest] = topic.split('/');
  if (!ID_RE.test(id || '')) return;
  let data;
  try { data = JSON.parse(payload.toString()); } catch { return; } // payload vuoto (retained cancellato) o non JSON
  const d = dev(id);
  const kind = rest.join('/');

  if (kind === 'telemetry') {
    const t = Date.now();
    d.lastSeen = t;
    d.online = true;
    d.telemetry = data;
    d.fw = data.fw ?? d.fw;
    const point = { t, temp_c: data.temp_c, heap_free: data.heap_free, rssi: data.rssi };
    d.history.push(point);
    if (d.history.length > HISTORY) d.history.shift();
    broadcast({ type: 'telemetry', id, telemetry: data, point });
    // Conferma finale OTA: il dispositivo e' ripartito con il firmware del job
    for (const j of jobs.values()) {
      if (j.deviceId === id && ACTIVE_OTA.includes(j.state) && data.fw === j.id) setJob(j, { state: 'done' });
    }
  } else if (kind === 'status') {
    d.online = !!data.online;
    d.lastSeen = Date.now();
    if (data.fw) d.fw = data.fw;
    if (data.ip) d.ip = data.ip;
    broadcast({ type: 'device', device: publicDevice(d) });
  } else if (kind === 'config/state') {
    d.config = data;
    broadcast({ type: 'device', device: publicDevice(d) });
  } else if (kind === 'ota/status') {
    d.ota = data;
    broadcast({ type: 'device', device: publicDevice(d) });
    const j = jobs.get(data.job_id);
    if (j && ACTIVE_OTA.includes(j.state)) {
      if (data.state === 'downloading') setJob(j, { state: 'ota-downloading', progress: data.progress ?? 0 });
      else if (data.state === 'success') setJob(j, { state: 'ota-installed', progress: 100 });
      else if (data.state === 'failed') setJob(j, { state: 'failed', error: `OTA: ${data.error || 'errore sconosciuto'}` });
    }
  }
});

// Dispositivi che spariscono senza LWT (rete cade): segna offline dopo 3 periodi
setInterval(() => {
  for (const d of devices.values()) {
    const limit = Math.max(30_000, 3000 * (d.telemetry?.interval_s || 10));
    if (d.online && d.lastSeen && Date.now() - d.lastSeen > limit) {
      d.online = false;
      broadcast({ type: 'device', device: publicDevice(d) });
    }
  }
}, 15_000);

const mqttPublish = (topic, obj) =>
  new Promise((resolve, reject) =>
    client.publish(topic, JSON.stringify(obj), { qos: 1 }, (e) => (e ? reject(e) : resolve())));

// ---------------------------------------------------------------- coda di compilazione
let chain = Promise.resolve();
let queued = 0;
const enqueue = (fn) => {
  queued++;
  const p = chain.then(fn, fn).finally(() => { queued--; });
  chain = p.catch(() => {});
  return p;
};

async function processJob(job, code, flash) {
  try {
    setJob(job, { state: 'compiling' });
    const r = await compile({ jobId: job.id, code, onLog: (l) => pushLog(job, l) });
    setJob(job, { state: 'compiled', md5: r.md5, size: r.size });
    if (!flash) return setJob(job, { state: 'done' });

    await mqttPublish(`iot/${job.deviceId}/cmd/ota`, {
      job_id: job.id,
      url: `${cfg.publicUrl}/firmware/${job.id}.bin?t=${job.fwToken}`,
      md5: r.md5,
      size: r.size,
    });
    setJob(job, { state: 'ota-requested' });
    job.otaTimer = setTimeout(() => {
      if (!['done', 'failed'].includes(job.state)) setJob(job, { state: 'failed', error: 'Timeout OTA' });
    }, cfg.otaTimeoutMs);
  } catch (e) {
    console.error('[job]', job.id, e.message);
    setJob(job, { state: 'failed', error: e.message });
  }
}

function pruneJobs() {
  while (jobs.size > cfg.keepJobs) {
    const [oldId] = jobs.keys();
    jobs.delete(oldId);
    fs.rm(path.join(cfg.artifactDir, `${oldId}.bin`), { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');

// Download firmware per l'ESP32: autenticato da token monouso per-job (niente Bearer sul device)
app.get('/firmware/:file', (req, res) => {
  const m = /^(job-[a-f0-9]{12})\.bin$/.exec(req.params.file);
  const job = m && jobs.get(m[1]);
  if (!job || !safeEq(String(req.query.t || ''), job.fwToken)) return res.sendStatus(403);
  res.type('application/octet-stream').sendFile(path.join(cfg.artifactDir, req.params.file));
});

const api = express.Router();
api.use(express.json({ limit: '512kb' }));
api.use((req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  const token = m ? m[1] : String(req.query.token || '');
  if (!safeEq(token, cfg.apiToken)) return res.status(401).json({ error: 'Non autorizzato' });
  next();
});

api.get('/device-config', (_req, res) => {
  res.json({
    mqttHost: cfg.device.mqttHost,
    mqttPort: cfg.device.mqttPort,
    mqttUser: cfg.device.mqttUser || '',
    mqttPass: cfg.device.mqttPass || '',
    mqttTls: !!cfg.device.mqttTls,
    publicUrl: cfg.publicUrl,
    wifiSsid: cfg.device.wifiSsid || '',
  });
});

api.get('/devices', (_req, res) => res.json([...devices.values()].map((d) => publicDevice(d, true))));

api.post('/devices/:id/config', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'deviceId non valido' });
  const b = req.body || {};
  const msg = {};
  if (b.interval_s !== undefined) {
    const v = Number(b.interval_s);
    if (!Number.isInteger(v) || v < 1 || v > 3600) return res.status(400).json({ error: 'interval_s deve essere un intero 1..3600' });
    msg.interval_s = v;
  }
  if (b.temp_offset_c !== undefined) {
    const v = Number(b.temp_offset_c);
    if (!Number.isFinite(v) || Math.abs(v) >= 50) return res.status(400).json({ error: 'temp_offset_c fuori range' });
    msg.temp_offset_c = v;
  }
  if (b.led !== undefined) {
    if (typeof b.led !== 'boolean') return res.status(400).json({ error: 'led deve essere boolean' });
    msg.led = b.led;
  }
  if (!Object.keys(msg).length) return res.status(400).json({ error: 'Nessun parametro valido' });
  try {
    await mqttPublish(`iot/${id}/config/set`, msg);
    res.json({ ok: true, sent: msg });
  } catch (e) {
    res.status(502).json({ error: `MQTT: ${e.message}` });
  }
});

api.post('/devices/:id/reboot', async (req, res) => {
  if (!ID_RE.test(req.params.id)) return res.status(400).json({ error: 'deviceId non valido' });
  try { await mqttPublish(`iot/${req.params.id}/cmd/reboot`, {}); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

api.get('/template', async (_req, res) => {
  res.json({ code: await fs.readFile(path.join(cfg.templateDir, 'src', 'main.cpp'), 'utf8') });
});

api.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  return j ? res.json(publicJob(j, true)) : res.sendStatus(404);
});

api.post('/compile-and-flash', (req, res) => {
  const { deviceId, code, flash = true } = req.body || {};
  const bad = validateSource(code);
  if (bad) return res.status(400).json({ error: bad });
  if (flash) {
    if (!ID_RE.test(deviceId || '')) return res.status(400).json({ error: 'deviceId non valido' });
    if (!devices.get(deviceId)?.online) return res.status(409).json({ error: 'Dispositivo offline: impossibile avviare l\'OTA' });
  }
  if (queued >= cfg.maxQueuedJobs) return res.status(429).json({ error: 'Troppe compilazioni in coda' });

  const job = {
    id: `job-${crypto.randomBytes(6).toString('hex')}`,
    deviceId: flash ? deviceId : null,
    flash: !!flash,
    state: 'queued',
    createdAt: Date.now(),
    log: [],
    fwToken: crypto.randomBytes(16).toString('hex'),
    otaTimer: null,
  };
  jobs.set(job.id, job);
  pruneJobs();
  broadcast({ type: 'job', job: publicJob(job) });
  enqueue(() => processJob(job, code, !!flash));
  res.status(202).json({ jobId: job.id });
});

app.use('/api', api);
app.use('/api', (_req, res) => res.sendStatus(404));

app.use(express.static(cfg.staticDir));
app.get('*', (_req, res) => res.sendFile(path.join(cfg.staticDir, 'index.html')));

// ---------------------------------------------------------------- server + WS upgrade
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname !== '/ws' || !safeEq(u.searchParams.get('token') || '', cfg.apiToken)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({
      type: 'snapshot',
      devices: [...devices.values()].map((d) => publicDevice(d, true)),
      jobs: [...jobs.values()].map((j) => publicJob(j, true)),
    }));
  });
});

server.listen(cfg.port, () => {
  console.log(`[http] in ascolto su :${cfg.port}`);
  if (cfg.local) {
    console.log(`\n  Dashboard: ${cfg.publicUrl}   (token: ${cfg.apiToken})`);
    console.log(`  Broker per l'ESP32: ${cfg.device.mqttHost}:${cfg.device.mqttPort}\n`);
  }
});
