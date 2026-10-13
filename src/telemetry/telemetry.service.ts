import {
  Inject,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { z } from 'zod';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { MqttService } from '../mqtt/mqtt.service.js';

const heartbeatSchema = z.object({
  ts: z.iso.datetime(),
  fw: z.string().optional(),
  uptime_s: z.number().int().optional(),
  rssi: z.number().int().optional(),
  temp_c: z.number().optional(),
  voltage_v: z.number().optional(),
  current_a: z.number().optional(),
  mode: z.enum(['MANUAL', 'AUTOMATIC']).optional(),
  /** Not in contract v0; accepted when firmware reports it. */
  battery_pct: z.number().int().min(0).max(100).optional(),
  /** CO2 lure remaining, percent. */
  co2_pct: z.number().int().min(0).max(100).optional(),
});

/** One analysed trap image (the image itself goes to storage separately). */
const captureSchema = z.object({
  ts: z.iso.datetime(),
  image_key: z.string().optional(),
  model: z.string().default('on-device'),
  detections: z
    .array(
      z.object({
        species: z.enum(['ANOPHELES', 'CULEX', 'AEDES', 'OTHER']),
        confidence: z.number().min(0).max(1),
        bbox: z.array(z.number()).length(4).optional(),
      }),
    )
    .max(50),
});

export type RecordedCapture = {
  capturedAt: Date;
  storageKey: string;
  model: string;
  detections?: z.infer<typeof captureSchema>['detections'];
  mosquitoCount?: number;
  aiLogId?: bigint;
};

const SPECIES_COLUMN = {
  ANOPHELES: 'anopheles',
  CULEX: 'culex',
  AEDES: 'aedes',
  OTHER: 'other',
} as const;

/** Captures are bucketed by Kigali calendar day and hour (UTC+2, no DST). */
function kigaliDayHour(at: Date) {
  const local = new Date(at.getTime() + 2 * 3600_000);
  return {
    date: new Date(local.toISOString().slice(0, 10)),
    hour: local.getUTCHours(),
  };
}

const stateSchema = z.object({
  ts: z.iso.datetime(),
  mode: z.enum(['MANUAL', 'AUTOMATIC']).optional(),
  /** Master power, not in contract v0 yet. */
  power: z.boolean().optional(),
  fan: z.boolean().optional(),
  uv: z.boolean().optional(),
  co2: z.boolean().optional(),
  camera: z.string().optional(),
});

/** Maps a device-reported actual state onto the confirmed-state columns. */
export function confirmedStateColumns(
  state: z.infer<typeof stateSchema> | Record<string, unknown>,
) {
  const s = state as Partial<z.infer<typeof stateSchema>>;
  return {
    ...(s.mode !== undefined && { mode: s.mode }),
    ...(s.power !== undefined && { powerOn: s.power }),
    ...(s.fan !== undefined && { fanOn: s.fan }),
    ...(s.uv !== undefined && { uvOn: s.uv }),
    ...(s.co2 !== undefined && { co2On: s.co2 }),
    ...(s.camera !== undefined && { cameraStatus: s.camera }),
  };
}

@Injectable()
export class TelemetryService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Telemetry');
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.mqtt.on('heartbeat', (id, p) => this.onHeartbeat(id, p));
    this.mqtt.on('status', (id, p) => this.onStatus(id, p));
    this.mqtt.on('state', (id, p) => this.onState(id, p));
    this.mqtt.on('captures', (id, p) => this.onCapture(id, p));
    if (this.env.MQTT_URL) {
      this.sweeper = setInterval(
        () =>
          this.markStaleDevicesOffline().catch((e: unknown) =>
            this.log.warn(`Offline sweep failed, retrying next tick: ${String(e)}`),
          ),
        15_000,
      );
    }
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  async onHeartbeat(deviceId: string, payload: unknown) {
    const hb = heartbeatSchema.parse(payload);
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) {
      this.log.warn(`Heartbeat from unknown device ${deviceId}`);
      return;
    }
    // Device clocks drift; trust our receive time for liveness, keep theirs for the record.
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.heartbeat.create({
        data: {
          deviceId,
          ts: new Date(hb.ts),
          firmware: hb.fw,
          uptimeS: hb.uptime_s,
          rssi: hb.rssi,
          tempC: hb.temp_c,
          voltageV: hb.voltage_v,
          currentA: hb.current_a,
          mode: hb.mode,
        },
      }),
      this.prisma.device.update({
        where: { id: deviceId },
        data: {
          lastSeenAt: now,
          status: device.status === 'OFFLINE' ? 'ONLINE' : device.status,
          firmware: hb.fw ?? device.firmware,
          ...(hb.battery_pct !== undefined && { batteryPct: hb.battery_pct }),
          ...(hb.co2_pct !== undefined && { co2LevelPct: hb.co2_pct }),
        },
      }),
      // A device that is reporting makes today a known day: no catches is 0, not NO_DATA.
      this.prisma.captureDay.upsert({
        where: { deviceId_date: { deviceId, date: kigaliDayHour(now).date } },
        create: { deviceId, date: kigaliDayHour(now).date, reported: true, hourly: Array(24).fill(0) },
        update: { reported: true },
      }),
    ]);
    if (device.status === 'OFFLINE') await this.raiseBackOnline(deviceId);
  }

  /** Stores an analysed image and adds its detections to the device's daily rollup. */
  async onCapture(deviceId: string, payload: unknown) {
    const c = captureSchema.parse(payload);
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { id: true } });
    if (!device) {
      this.log.warn(`Capture from unknown device ${deviceId}`);
      return;
    }
    await this.recordCapture(deviceId, {
      capturedAt: new Date(c.ts),
      storageKey: c.image_key ?? `pending/${deviceId}/${c.ts}.jpg`,
      model: c.model,
      detections: c.detections,
    });
  }

  /**
   * Stores one analysed image and adds it to the device's daily rollup.
   * Count-only models (the AI service today) pass mosquitoCount and no detections;
   * those go to the unidentified column: counted in totals, never shown as a species.
   */
  async recordCapture(deviceId: string, capture: RecordedCapture) {
    const { capturedAt, detections = [], mosquitoCount } = capture;
    const { date, hour } = kigaliDayHour(capturedAt);
    const counts = { anopheles: 0, culex: 0, aedes: 0, other: 0, unidentified: 0 };
    for (const d of detections) counts[SPECIES_COLUMN[d.species]]++;
    const total = detections.length || (mosquitoCount ?? 0);
    if (!detections.length) counts.unidentified = total;
    const hourly = Array<number>(24).fill(0);
    hourly[hour] = total;

    await this.prisma.$transaction(async (tx) => {
      await tx.image.create({
        data: {
          deviceId,
          capturedAt,
          storageKey: capture.storageKey,
          aiLogId: capture.aiLogId,
          aiResults: {
            create: {
              modelVersion: capture.model,
              mosquitoCount: mosquitoCount ?? null,
              detections: {
                create: detections.map((d) => ({ species: d.species, confidence: d.confidence, bbox: d.bbox ?? [] })),
              },
            },
          },
        },
      });
      const day = await tx.captureDay.findUnique({ where: { deviceId_date: { deviceId, date } } });
      if (!day) {
        await tx.captureDay.create({ data: { deviceId, date, reported: true, ...counts, hourly } });
      } else {
        const merged = day.hourly.length === 24 ? [...day.hourly] : Array<number>(24).fill(0);
        merged[hour] += total;
        await tx.captureDay.update({
          where: { deviceId_date: { deviceId, date } },
          data: {
            reported: true,
            anopheles: { increment: counts.anopheles },
            culex: { increment: counts.culex },
            aedes: { increment: counts.aedes },
            other: { increment: counts.other },
            unidentified: { increment: counts.unidentified },
            hourly: merged,
          },
        });
      }
    });
  }

  async onStatus(deviceId: string, payload: unknown) {
    const status =
      typeof payload === 'string'
        ? payload
        : (payload as { status?: string } | null)?.status;
    if (status === 'offline')
      await this.markOffline([deviceId], 'Device reported offline (last will)');
  }

  async onState(deviceId: string, payload: unknown) {
    const state = stateSchema.parse(payload);
    await this.prisma.device.updateMany({
      where: { id: deviceId },
      data: {
        ...confirmedStateColumns(state),
        stateUpdatedAt: new Date(state.ts),
      },
    });
  }

  /** Marks devices whose last heartbeat is older than the timeout as OFFLINE. Returns their ids. */
  async markStaleDevicesOffline(now = new Date()): Promise<string[]> {
    const cutoff = new Date(
      now.getTime() - this.env.DEVICE_HEARTBEAT_TIMEOUT_S * 1000,
    );
    const stale = await this.prisma.device.findMany({
      where: { status: { not: 'OFFLINE' }, lastSeenAt: { lt: cutoff }, cameraId: null },
      select: { id: true },
    });
    // A heartbeat may be received but still queued for the database: trust receive time too.
    const ids = stale
      .map((d) => d.id)
      .filter((id) => (this.mqtt.lastHeard.get(id) ?? 0) < cutoff.getTime());
    if (ids.length)
      await this.markOffline(ids, 'No heartbeat received within the timeout');
    return ids;
  }

  async markOffline(ids: string[], reason: string) {
    const devices = await this.prisma.device.findMany({
      where: { id: { in: ids }, status: { not: 'OFFLINE' } },
      include: { area: true },
    });
    if (!devices.length) return;
    await this.prisma.$transaction([
      // Battery becomes unknown, not zero, once the device stops reporting.
      this.prisma.device.updateMany({
        where: { id: { in: devices.map((d) => d.id) } },
        data: { status: 'OFFLINE', batteryPct: null },
      }),
      this.prisma.alert.createMany({
        data: devices.map((d) => ({
          kind: 'DEVICE_OFFLINE' as const,
          severity: 'MEDIUM' as const,
          title: 'Device offline',
          location: `Device #${d.id} (${d.area.site})`,
          message: reason,
          deviceId: d.id,
          areaId: d.areaId,
        })),
      }),
    ]);
    this.log.log(`Marked offline: ${devices.map((d) => d.id).join(', ')}`);
  }

  async raiseBackOnline(deviceId: string) {
    const device = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
      include: { area: true },
    });
    await this.prisma.alert.create({
      data: {
        kind: 'DEVICE_ONLINE',
        severity: 'INFO',
        title: 'Device back online',
        location: `Device #${deviceId} (${device.area.site})`,
        message: 'Telemetry heartbeat resumed',
        deviceId,
        areaId: device.areaId,
      },
    });
  }
}

@Module({ providers: [TelemetryService], exports: [TelemetryService] })
export class TelemetryModule {}
