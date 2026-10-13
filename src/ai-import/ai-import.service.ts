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
import {
  TelemetryModule,
  TelemetryService,
} from '../telemetry/telemetry.service.js';

/** One row of the AI service's trap_analytics_log (mosqai-ai/db/schema.sql). */
const logRowSchema = z.object({
  id: z.coerce.bigint(),
  trap_id: z.string(),
  image_uid: z.string().nullable(),
  new_mosquitoes_count: z.number().int(),
  event_type: z.string().default('frame'),
  logged_at: z.string(),
});
type LogRow = z.infer<typeof logRowSchema>;

const PAGE = 500;

/**
 * Imports the AI service's results. Phase A camera traps post frames straight to
 * the AI service, which logs every frame to Supabase. This polls that log and:
 * - marks the linked device online when frames arrive, offline when they stop;
 * - records frames with new mosquitoes as captures (photo + count).
 * A device is linked to a camera through Device.cameraId (= the camera's trap_id).
 */
@Injectable()
export class AiImportService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AiImport');
  private timer?: NodeJS.Timeout;
  private cursor?: bigint;
  private running = false;
  private readonly unknownTraps = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly telemetry: TelemetryService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get enabled() {
    return Boolean(this.env.SUPABASE_URL && this.env.SUPABASE_SECRET_KEY);
  }

  onModuleInit() {
    if (!this.enabled) {
      this.log.log('SUPABASE_URL / SUPABASE_SECRET_KEY not set: AI result import is off');
      return;
    }
    const tick = () =>
      this.sync().catch((e: unknown) =>
        this.log.warn(`AI import failed, retrying next tick: ${String(e)}`),
      );
    void tick();
    this.timer = setInterval(tick, this.env.AI_IMPORT_INTERVAL_S * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** One import pass. Returns how many log rows were read. */
  async sync(now = new Date()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      // Captures are unique per AI log row, so restarting from the last imported one is safe.
      this.cursor ??=
        (await this.prisma.image.aggregate({ _max: { aiLogId: true } }))._max
          .aiLogId ?? 0n;

      const cameras = await this.prisma.device.findMany({
        where: { cameraId: { not: null } },
        select: { id: true, cameraId: true, status: true, lastSeenAt: true },
      });
      const byTrap = new Map(cameras.map((d) => [d.cameraId!, d]));
      const lastFrame = new Map<string, Date>();
      let read = 0;

      for (;;) {
        const rows = await this.fetchAfter(this.cursor);
        read += rows.length;
        for (const row of rows) {
          await this.importRow(row, byTrap, lastFrame);
          this.cursor = row.id;
        }
        if (rows.length < PAGE) break;
      }

      await this.updatePresence(cameras, lastFrame, now);
      return read;
    } finally {
      this.running = false;
    }
  }

  private async fetchAfter(cursor: bigint): Promise<LogRow[]> {
    const url = new URL(`${this.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/trap_analytics_log`);
    url.searchParams.set('select', 'id,trap_id,image_uid,new_mosquitoes_count,event_type,logged_at');
    url.searchParams.set('id', `gt.${cursor}`);
    url.searchParams.set('order', 'id.asc');
    url.searchParams.set('limit', String(PAGE));
    const key = this.env.SUPABASE_SECRET_KEY;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Supabase responded ${res.status}: ${await res.text()}`);
    return z.array(logRowSchema).parse(await res.json());
  }

  private async importRow(
    row: LogRow,
    byTrap: Map<string, { id: string }>,
    lastFrame: Map<string, Date>,
  ) {
    const device = byTrap.get(row.trap_id);
    if (!device) {
      if (!this.unknownTraps.has(row.trap_id)) {
        this.unknownTraps.add(row.trap_id);
        this.log.warn(`AI results for camera "${row.trap_id}" ignored: no device has that cameraId`);
      }
      return;
    }
    if (row.event_type !== 'frame') return;

    const loggedAt = new Date(row.logged_at);
    const prev = lastFrame.get(device.id);
    if (!prev || loggedAt > prev) lastFrame.set(device.id, loggedAt);

    if (row.new_mosquitoes_count <= 0) return;
    const exists = await this.prisma.image.findUnique({ where: { aiLogId: row.id }, select: { id: true } });
    if (exists) return;
    await this.telemetry.recordCapture(device.id, {
      capturedAt: loggedAt,
      // Frames without a photo (Cloudinary not configured) still count.
      storageKey: row.image_uid ? `cloudinary:${row.image_uid}` : `ai-log/${row.id}`,
      model: this.env.AI_MODEL_VERSION,
      mosquitoCount: row.new_mosquitoes_count,
      aiLogId: row.id,
    });
  }

  private async updatePresence(
    cameras: { id: string; status: string; lastSeenAt: Date | null }[],
    lastFrame: Map<string, Date>,
    now: Date,
  ) {
    const cutoff = now.getTime() - this.env.CAMERA_OFFLINE_AFTER_S * 1000;
    const stale: string[] = [];
    for (const cam of cameras) {
      // The camera's own frames are the truth for when it was last seen; rows arrive
      // in order, so the newest imported frame always wins over any stored value.
      const frame = lastFrame.get(cam.id);
      const seen = frame ?? cam.lastSeenAt;
      const fresh = seen !== null && seen.getTime() >= cutoff;
      if (frame) {
        await this.prisma.device.update({
          where: { id: cam.id },
          data: { lastSeenAt: frame, ...(fresh && { status: 'ONLINE' }) },
        });
        if (fresh && cam.status === 'OFFLINE') await this.telemetry.raiseBackOnline(cam.id);
      }
      if (!fresh && cam.status !== 'OFFLINE') stale.push(cam.id);
    }
    if (stale.length)
      await this.telemetry.markOffline(stale, 'No camera frame received within the expected interval');
  }
}

@Module({
  imports: [TelemetryModule],
  providers: [AiImportService],
  exports: [AiImportService],
})
export class AiImportModule {}
