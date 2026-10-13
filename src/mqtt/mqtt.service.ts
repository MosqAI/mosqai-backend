import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import mqtt, { type MqttClient } from 'mqtt';
import { ENV, type Env } from '../config/env.js';

// Topics from mosqai-docs/contracts/mqtt.md (v0 DRAFT, not yet approved).
export const TOPIC_ROOT = 'mosqai/v1/devices';
export type DeviceChannel =
  'status' | 'heartbeat' | 'state' | 'events' | 'captures' | 'commands' | 'commands/ack';

export const deviceTopic = (deviceId: string, channel: DeviceChannel) =>
  `${TOPIC_ROOT}/${deviceId}/${channel}`;

/** Splits `mosqai/v1/devices/{id}/{channel}`; null for anything else. */
export function parseDeviceTopic(
  topic: string,
): { deviceId: string; channel: string } | null {
  const prefix = `${TOPIC_ROOT}/`;
  if (!topic.startsWith(prefix)) return null;
  const [deviceId, ...rest] = topic.slice(prefix.length).split('/');
  return deviceId && rest.length ? { deviceId, channel: rest.join('/') } : null;
}

type Handler = (deviceId: string, payload: unknown) => Promise<void>;

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Mqtt');
  private client?: MqttClient;
  private readonly handlers = new Map<string, Handler>();
  private queue: Promise<void> = Promise.resolve();
  /** When each device last sent anything, by receive time (ms). */
  readonly lastHeard = new Map<string, number>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  /** Registers the handler for one inbound channel (device → backend). */
  on(
    channel: 'status' | 'heartbeat' | 'state' | 'events' | 'captures' | 'commands/ack',
    handler: Handler,
  ) {
    this.handlers.set(channel, handler);
  }

  get connected() {
    return this.client?.connected ?? false;
  }

  onModuleInit() {
    if (!this.env.MQTT_URL) {
      this.log.warn(
        'MQTT_URL is empty: device telemetry and commands are disabled',
      );
      return;
    }
    this.client = mqtt.connect(this.env.MQTT_URL, {
      username: this.env.MQTT_USERNAME,
      password: this.env.MQTT_PASSWORD,
      clientId: `mosqai-backend-${process.pid}`,
      reconnectPeriod: 2000,
    });
    this.client.on('connect', () => {
      this.log.log(`Connected to ${this.env.MQTT_URL}`);
      this.client!.subscribe(
        ['status', 'heartbeat', 'state', 'events', 'captures', 'commands/ack'].map(
          (c) => `${TOPIC_ROOT}/+/${c}`,
        ),
        { qos: 1 },
      );
    });
    this.client.on('error', (err) =>
      this.log.warn(`MQTT error: ${err.message}`),
    );
    // Handle messages one at a time, in arrival order: a device's ack and state
    // updates must apply in sequence, and fleet-wide heartbeat bursts shouldn't
    // fight over database connections.
    this.client.on('message', (topic, buf) => {
      // Noted on arrival, before the (possibly slow) database write, so a busy
      // database cannot make a device that is talking look silent.
      const parsed = parseDeviceTopic(topic);
      if (parsed && parsed.channel !== 'status') this.lastHeard.set(parsed.deviceId, Date.now());
      this.queue = this.queue.then(() => this.dispatch(topic, buf));
    });
  }

  async publish(
    topic: string,
    payload: unknown,
    opts: { qos?: 0 | 1; retain?: boolean } = {},
  ) {
    if (!this.client) throw new Error('MQTT is not configured');
    await this.client.publishAsync(topic, JSON.stringify(payload), {
      qos: opts.qos ?? 1,
      retain: opts.retain,
    });
  }

  async onModuleDestroy() {
    await this.client?.endAsync();
  }

  private async dispatch(topic: string, buf: Buffer) {
    const parsed = parseDeviceTopic(topic);
    const handler = parsed && this.handlers.get(parsed.channel);
    if (!parsed || !handler) return;
    let payload: unknown;
    try {
      payload = buf.length ? JSON.parse(buf.toString('utf8')) : null;
    } catch {
      this.log.warn(`Ignoring non-JSON payload on ${topic}`);
      return;
    }
    try {
      await handler(parsed.deviceId, payload);
    } catch (err) {
      this.log.error(`Handler failed for ${topic}: ${(err as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [MqttService], exports: [MqttService] })
export class MqttModule {}
