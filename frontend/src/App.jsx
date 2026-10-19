import { useEffect, useReducer, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import './styles.css';

// ------------------------------------------------------------------ API
async function api(token, path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (!r.ok) {
    const b = await r.json().catch(() => ({}));
    const e = new Error(b.error || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

// ------------------------------------------------------------------ stato real-time via WebSocket
const init = { devices: {}, jobs: {} };
function reducer(s, a) {
  switch (a.type) {
    case 'snapshot':
      return {
        devices: Object.fromEntries(a.devices.map((d) => [d.id, d])),
        jobs: Object.fromEntries(a.jobs.map((j) => [j.id, j])),
      };
    case 'device':
      return { ...s, devices: { ...s.devices, [a.device.id]: { history: [], ...s.devices[a.device.id], ...a.device } } };
    case 'telemetry': {
      const d = s.devices[a.id] || { id: a.id, history: [] };
      const history = [...(d.history || []), a.point].slice(-120);
      return { ...s, devices: { ...s.devices, [a.id]: { ...d, online: true, telemetry: a.telemetry, history } } };
    }
    case 'job':
      return { ...s, jobs: { ...s.jobs, [a.job.id]: { log: [], ...s.jobs[a.job.id], ...a.job } } };
    case 'joblog': {
      const j = s.jobs[a.id];
      return j ? { ...s, jobs: { ...s.jobs, [a.id]: { ...j, log: [...j.log, a.line].slice(-300) } } } : s;
    }
    default:
      return s;
  }
}

function useIot(token) {
  const [state, dispatch] = useReducer(reducer, init);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws, timer, closed = false, attempt = 0;
    const open = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => { attempt = 0; setConnected(true); };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) timer = setTimeout(open, Math.min(1000 * 2 ** attempt++, 15000));
      };
      ws.onmessage = (e) => dispatch(JSON.parse(e.data));
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws?.close(); };
  }, [token]);
  return { state, connected };
}

// ------------------------------------------------------------------ componenti
const fmtUptime = (s = 0) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'g ' : ''}${h}h ${m}m ${s % 60}s`;
};

function Login({ onLogin }) {
  const [v, setV] = useState('');
  return (
    <form className="panel login" onSubmit={(e) => { e.preventDefault(); v && onLogin(v); }}>
      <h2>ESP32 Cloud Console</h2>
      <label>Token di accesso (API_TOKEN)
        <input type="password" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      </label>
      <p><button className="btn">Accedi</button></p>
    </form>
  );
}

function Telemetry({ device }) {
  const t = device.telemetry;
  const data = (device.history || []).map((p) => ({ ...p, time: new Date(p.t).toLocaleTimeString() }));
  return (
    <section className="panel">
      <h2>Telemetria</h2>
      <div className="cards">
        <div className="card"><div className="v">{t ? t.temp_c.toFixed(1) + ' °C' : '—'}</div><div className="k">Temperatura</div></div>
        <div className="card"><div className="v">{t ? Math.round(t.heap_free / 1024) + ' KB' : '—'}</div><div className="k">RAM libera</div></div>
        <div className="card"><div className="v">{t ? t.rssi + ' dBm' : '—'}</div><div className="k">RSSI</div></div>
        <div className="card"><div className="v">{t ? fmtUptime(t.uptime_s) : '—'}</div><div className="k">Uptime</div></div>
        <div className="card"><div className="v" style={{ fontSize: 14 }}>{device.fw || '—'}</div><div className="k">Firmware · {device.ip || ''}</div></div>
      </div>
      <div style={{ height: 220, marginTop: 14 }}>
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid stroke="#2a3340" strokeDasharray="3 3" />
            <XAxis dataKey="time" stroke="#8b98a8" fontSize={11} minTickGap={40} />
            <YAxis stroke="#8b98a8" fontSize={11} domain={['auto', 'auto']} unit="°" />
            <Tooltip contentStyle={{ background: '#1a2029', border: '1px solid #2a3340' }} />
            <Line type="monotone" dataKey="temp_c" name="Temp °C" stroke="#4da3ff" dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

function ConfigForm({ token, device, onUnauthorized }) {
  const cfg = device.config;
  const [form, setForm] = useState({ interval_s: 5, temp_offset_c: 0, led: true });
  const [msg, setMsg] = useState('');
  useEffect(() => { if (cfg) setForm({ interval_s: cfg.interval_s, temp_offset_c: cfg.temp_offset_c, led: cfg.led }); }, [cfg]);

  const submit = async (e) => {
    e.preventDefault();
    setMsg('');
    try {
      await api(token, `/api/devices/${device.id}/config`, {
        method: 'POST',
        body: JSON.stringify({ interval_s: Number(form.interval_s), temp_offset_c: Number(form.temp_offset_c), led: form.led }),
      });
      setMsg('Inviato: in attesa di conferma dal dispositivo…');
    } catch (err) {
      if (err.status === 401) onUnauthorized();
      setMsg('Errore: ' + err.message);
    }
  };
  return (
    <section className="panel">
      <h2>Configurazione (senza riavvio)</h2>
      <form className="row" onSubmit={submit}>
        <label>Intervallo invio (s)
          <input type="number" min="1" max="3600" value={form.interval_s} onChange={(e) => setForm({ ...form, interval_s: e.target.value })} />
        </label>
        <label>Offset temperatura (°C)
          <input type="number" step="0.1" value={form.temp_offset_c} onChange={(e) => setForm({ ...form, temp_offset_c: e.target.value })} />
        </label>
        <label>LED
          <input type="checkbox" checked={form.led} onChange={(e) => setForm({ ...form, led: e.target.checked })} />
        </label>
        <button className="btn" disabled={!device.online}>Applica</button>
      </form>
      <div className="muted" style={{ marginTop: 8 }}>
        Stato confermato dal dispositivo: {cfg ? `${cfg.interval_s}s · offset ${cfg.temp_offset_c} · LED ${cfg.led ? 'on' : 'off'}` : '—'}
      </div>
      {msg && <div className={msg.startsWith('Errore') ? 'err' : 'muted'}>{msg}</div>}
    </section>
  );
}

const STATE = {
  queued: ['In coda', 'run'], compiling: ['Compilazione…', 'run'], compiled: ['Compilato', 'run'],
  'ota-requested': ['OTA richiesto', 'run'], 'ota-downloading': ['Download sul dispositivo…', 'run'],
  'ota-installed': ['Installato, riavvio…', 'run'], done: ['Completato', 'ok'], failed: ['Fallito', 'bad'],
};

function Firmware({ token, device, jobs, onUnauthorized }) {
  const [code, setCode] = useState('');
  const [jobId, setJobId] = useState(null);
  const [err, setErr] = useState('');
  const job = jobId ? jobs[jobId] : null;
  const running = job && !['done', 'failed'].includes(job.state);

  const loadTemplate = () => api(token, '/api/template').then((r) => setCode(r.code)).catch((e) => setErr(e.message));
  useEffect(() => { loadTemplate(); /* eslint-disable-next-line */ }, []);

  const submit = async (flash) => {
    setErr('');
    try {
      const r = await api(token, '/api/compile-and-flash', {
        method: 'POST', body: JSON.stringify({ deviceId: device?.id, code, flash }),
      });
      setJobId(r.jobId);
    } catch (e) {
      if (e.status === 401) onUnauthorized();
      setErr(e.message);
    }
  };
  const [label, cls] = job ? STATE[job.state] || [job.state, ''] : [];

  return (
    <section className="panel">
      <h2>Firmware da codice sorgente</h2>
      <textarea spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn" disabled={running || !device?.online || !code} onClick={() => submit(true)}>Compila &amp; Aggiorna ESP32</button>
        <button className="btn sec" disabled={running || !code} onClick={() => submit(false)}>Solo compila</button>
        <label className="btn sec" style={{ cursor: 'pointer', color: 'var(--text)' }}>
          Carica .cpp / .ino
          <input type="file" accept=".cpp,.ino,.c,.h" hidden onChange={async (e) => { const f = e.target.files[0]; if (f) setCode(await f.text()); e.target.value = ''; }} />
        </label>
        <button className="btn sec" onClick={loadTemplate}>Ripristina template</button>
      </div>
      {!device?.online && <div className="muted" style={{ marginTop: 8 }}>Il dispositivo deve essere online per l'OTA.</div>}
      {err && <div className="err">{err}</div>}
      {job && (
        <div style={{ marginTop: 12 }}>
          <span className={`badge ${cls}`}>{label}</span>{' '}
          <span className="muted">{job.id}{job.md5 ? ` · ${(job.size / 1024).toFixed(0)} KB · md5 ${job.md5.slice(0, 8)}…` : ''}</span>
          {job.state === 'ota-downloading' && <progress max="100" value={job.progress || 0} />}
          {job.error && <div className="err">{job.error}</div>}
          {job.log?.length > 0 && <pre className="log">{job.log.join('\n')}</pre>}
        </div>
      )}
    </section>
  );
}

function Dashboard({ token, onLogout }) {
  const { state, connected } = useIot(token);
  const [sel, setSel] = useState(null);
  const list = Object.values(state.devices).sort((a, b) => a.id.localeCompare(b.id));
  const device = state.devices[sel] || list[0];

  return (
    <>
      <header>
        <h1>ESP32 Cloud Console</h1>
        <span className={`badge ${connected ? 'ok' : 'bad'}`}>{connected ? 'live' : 'disconnesso'}</span>
        <button className="btn sec" onClick={onLogout}>Esci</button>
      </header>
      <main>
        <aside>
          <div className="panel">
            <h2>Dispositivi</h2>
            {list.length === 0 && <div className="muted">Nessun dispositivo visto finora.</div>}
            {list.map((d) => (
              <button key={d.id} className={`dev ${device?.id === d.id ? 'sel' : ''}`} onClick={() => setSel(d.id)}>
                <span className={`dot ${d.online ? 'on' : ''}`} />{d.id}
              </button>
            ))}
          </div>
        </aside>
        <div>
          {device ? (
            <>
              <Telemetry device={device} />
              <ConfigForm token={token} device={device} onUnauthorized={onLogout} />
            </>
          ) : <div className="panel muted">In attesa di telemetria dai dispositivi…</div>}
          <Firmware token={token} device={device} jobs={state.jobs} onUnauthorized={onLogout} />
        </div>
      </main>
    </>
  );
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('token') || '');
  if (!token) return <Login onLogin={(t) => { localStorage.setItem('token', t); setToken(t); }} />;
  return <Dashboard token={token} onLogout={() => { localStorage.removeItem('token'); setToken(''); }} />;
}
