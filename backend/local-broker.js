import net from 'node:net';
import Aedes from 'aedes';

/**
 * Broker MQTT integrato per la modalità locale (nessun Mosquitto/Docker).
 * Accetta connessioni anonime: usarlo solo su una rete di fiducia (LAN domestica).
 * Retained, LWT e QoS 1 sono supportati, quindi il protocollo e' identico a quello cloud.
 */
export function startLocalBroker(port) {
  const aedes = new Aedes();
  const server = net.createServer(aedes.handle);
  server.on('error', (e) => {
    console.error(`[broker] impossibile aprire la porta ${port}: ${e.message}`);
    console.error('         (un altro broker, es. Mosquitto, e\' gia\' attivo? Imposta LOCAL_BROKER=0 e MQTT_URL)');
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => console.log(`[broker] MQTT integrato su :${port}`));
  aedes.on('client', (c) => console.log(`[broker] connesso: ${c.id}`));
  aedes.on('clientDisconnect', (c) => console.log(`[broker] disconnesso: ${c.id}`));
  return { aedes, server };
}
