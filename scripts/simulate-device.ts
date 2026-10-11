// Device simulator (workflow.md "simulators unblock each other"): publishes
// heartbeats and applies + acknowledges commands like real firmware would,
// following contract v0 (mosqai-docs/contracts/mqtt.md, DRAFT).
//
// Usage:
//   pnpm simulate MSQ-001 [MSQ-002 ...]   simulate specific devices
//   pnpm simulate --fleet                 every seeded device except the ones seeded offline
// Options:
//   --fail-rate 0.1   fraction of commands acked as FAILED
//   --silent          never ack commands (exercises the TIMED_OUT path)
import 'dotenv/config';
import mqtt from 'mqtt';

const args = process.argv.slice(2);
const failRate = Number(args[args.indexOf('--fail-rate') + 1]) || 0;
const silent = args.includes('--silent');
const url = process.env.MQTT_URL || 'mqtt://127.0.0.1:1883';

// The seed leaves MSQ-004 and MSQ-021 offline on purpose, to show coverage gaps.
const SEEDED_OFFLINE = new Set(['MSQ-004', 'MSQ-021']);
const ids = args.includes('--fleet')
  ? Array.from(
      { length: 26 },
      (_, i) => `MSQ-${String(i + 1).padStart(3, '0')}`,
    ).filter((id) => !SEEDED_OFFLINE.has(id))
  : args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--fail-rate');
if (ids.length === 0) ids.push('MSQ-001');

function simulate(deviceId: string) {
  const base = `mosqai/v1/devices/${deviceId}`;
  const state = {
    mode: 'AUTOMATIC',
    power: true,
    fan: true,
    uv: true,
    co2: false,
    camera: 'ok',
  };
  const applied = new Set<string>(); // command_ids already executed (idempotent retries)
  // Synced power schedule; real firmware stores this in flash so it survives reboots and outages.
  let schedule: { action: 'ON' | 'OFF'; time: string; days: number[] }[] = [];
  let lastScheduleMinute = '';

  /** Master power drives the fan and UV light together; CO₂ stays off when powered down. */
  const setPower = (on: boolean) => {
    state.power = on;
    state.fan = on;
    state.uv = on;
    if (!on) state.co2 = false;
  };

  /** In AUTOMATIC mode, apply any rule due this minute (Africa/Kigali, UTC+2). */
  const runSchedule = async () => {
    if (state.mode !== 'AUTOMATIC' || schedule.length === 0) return;
    const kigali = new Date(Date.now() + 2 * 3600_000);
    const hhmm = kigali.toISOString().slice(11, 16);
    const day = kigali.getUTCDay();
    if (hhmm === lastScheduleMinute) return;
    lastScheduleMinute = hhmm;
    const due = schedule.filter(
      (r) => r.time === hhmm && (r.days.length === 0 || r.days.includes(day)),
    );
    if (due.length === 0) return;
    setPower(due.at(-1)!.action === 'ON');
    log(`⏰ schedule ${hhmm}: power ${state.power ? 'ON' : 'OFF'}`);
    await publish('state', { ts: new Date().toISOString(), ...state }, true);
  };
  const started = Date.now();
  // CO2 lure remaining (%). MSQ-002 starts low so the "refill" advice shows in the owner app.
  const idNum = Number(deviceId.slice(4)) || 1;
  let co2Pct = deviceId === "MSQ-002" ? 18 : 35 + ((idNum * 37) % 60);

  const SPECIES = ["CULEX", "CULEX", "CULEX", "CULEX", "CULEX", "ANOPHELES", "ANOPHELES", "ANOPHELES", "AEDES", "OTHER"] as const;
  /** While powered, now and then an analysed image arrives; most bites happen in the evening. */
  const maybeCapture = async () => {
    if (!state.power) return;
    const hour = new Date(Date.now() + 2 * 3600_000).getUTCHours();
    const chance = hour >= 18 && hour <= 23 ? 0.6 : hour <= 5 ? 0.35 : 0.12;
    if (Math.random() > chance) return;
    const n = 1 + Math.floor(Math.random() * 3);
    const detections = Array.from({ length: n }, () => ({
      species: SPECIES[Math.floor(Math.random() * SPECIES.length)],
      confidence: Math.round((0.8 + Math.random() * 0.19) * 100) / 100,
      bbox: [200, 140, 320, 260],
    }));
    await publish("captures", { ts: new Date().toISOString(), model: "yolo-mosq-0.3.1", detections });
  };
  const log = (msg: string) => console.log(`[${deviceId}] ${msg}`);

  const client = mqtt.connect(url, {
    clientId: `sim-${deviceId}`,
    will: {
      topic: `${base}/status`,
      payload: Buffer.from(JSON.stringify({ status: 'offline' })),
      qos: 1,
      retain: true,
    },
  });
  const publish = (channel: string, payload: unknown, retain = false) =>
    client.publishAsync(`${base}/${channel}`, JSON.stringify(payload), {
      qos: 1,
      retain,
    });

  const heartbeat = () =>
    publish('heartbeat', {
      ts: new Date().toISOString(),
      fw: '0.1.0-sim',
      uptime_s: Math.round((Date.now() - started) / 1000),
      rssi: -55 - Math.round(Math.random() * 15),
      temp_c: 28 + Math.round(Math.random() * 40) / 10,
      voltage_v: 11.9,
      current_a: state.fan ? 0.82 : 0.21,
      mode: state.mode,
      battery_pct: 80,
      co2_pct: Math.round(co2Pct),
    });

  client.on('connect', async () => {
    log(`connected to ${url}${silent ? ' (silent: no acks)' : ''}`);
    await client.subscribeAsync(`${base}/commands`, { qos: 1 });
    await publish('status', { status: 'online' }, true);
    await publish('state', { ts: new Date().toISOString(), ...state }, true);
    await heartbeat();
    setInterval(() => {
      // The lure drains about 1% every 10 minutes while the trap is running.
      if (state.power) co2Pct = Math.max(0, co2Pct - 0.05);
      void heartbeat();
    }, 30_000);
    setInterval(() => void maybeCapture(), 60_000);
    setInterval(() => void runSchedule(), 15_000);
  });

  client.on('message', async (_topic, buf) => {
    const cmd = JSON.parse(buf.toString()) as {
      command_id: string;
      type: string;
      params: Record<string, unknown>;
      expires_at: string;
    };
    log(`← ${cmd.type} ${JSON.stringify(cmd.params)}`);
    if (silent) return;

    const ack = (result: string, error: string | null = null) =>
      publish('commands/ack', {
        command_id: cmd.command_id,
        result,
        actual_state: { ...state },
        error,
        ts: new Date().toISOString(),
      });

    if (applied.has(cmd.command_id)) return ack('DUPLICATE');
    if (new Date(cmd.expires_at) < new Date())
      return ack('REJECTED', 'expired');
    if (Math.random() < failRate)
      return ack('FAILED', 'actuator did not respond');

    const on = Boolean(cmd.params.on);
    switch (cmd.type) {
      case 'SET_POWER':
        setPower(on);
        break;
      case 'SET_FAN':
        state.fan = on;
        state.power = state.fan || state.uv;
        break;
      case 'SET_UV':
        state.uv = on;
        state.power = state.fan || state.uv;
        break;
      case 'SET_CO2':
        state.co2 = on;
        break;
      case 'SET_MODE':
        state.mode = String(cmd.params.mode ?? state.mode);
        break;
      case 'SYNC_SCHEDULE':
        schedule = (cmd.params.rules as typeof schedule) ?? [];
        log(
          `schedule synced: ${schedule.map((r) => `${r.action}@${r.time}`).join(', ') || '(none)'}`,
        );
        break;
      case 'CAPTURE_IMAGE':
      case 'REBOOT':
        break;
      default:
        return ack('REJECTED', `unknown command ${cmd.type}`);
    }
    // Real firmware re-reads the hardware here; the ack carries what is actually true.
    applied.add(cmd.command_id);
    await new Promise((r) => setTimeout(r, 300));
    await ack('OK');
    await publish('state', { ts: new Date().toISOString(), ...state }, true);
    log(`→ ack OK ${JSON.stringify(state)}`);
  });

  return client;
}

const clients = ids.map(simulate);
process.on('SIGINT', () => {
  // A clean disconnect skips the last will; real power loss would trigger it.
  Promise.all(clients.map((c) => c.endAsync())).finally(() => process.exit(0));
});
