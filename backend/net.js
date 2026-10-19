import os from 'node:os';

/** Primo IPv4 non interno, preferendo gli intervalli privati tipici delle LAN domestiche. */
export function lanIp() {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  const isPrivate = (a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a);
  return all.find(isPrivate) || all[0] || '127.0.0.1';
}
