// In-process MQTT broker for local development when Mosquitto (Docker) isn't
// available. No TLS and no auth: it only listens on localhost.
// Usage: pnpm dev:broker [port]
import { Aedes } from 'aedes';
import { createServer } from 'node:net';

const port = Number(process.argv[2] ?? 1883);
const broker = await Aedes.createBroker();
createServer(broker.handle).listen(port, '127.0.0.1', () => {
  console.log(`Dev MQTT broker on mqtt://127.0.0.1:${port}`);
});
