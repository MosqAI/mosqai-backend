// End-to-end: AI service results (Supabase trap_analytics_log) imported into the backend.
// Supabase is replaced by a fetch stub; the database is real. Fixtures use MSQ-9901xx ids.
import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { AiImportService } from '../src/ai-import/ai-import.service.js';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { parseEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.module.js';

const DEVICE = 'MSQ-990101';
const CAMERA = 'E2E-CAM-1';
const AREA = 'E2E AI Import Area';
const OWNER_EMAIL = 'e2e-ai-owner@example.test';
const PASSWORD = 'e2e-password-123';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('AI result import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let importer: AiImportService;
  let http: ReturnType<typeof request>;
  let token: string;
  let rows: Record<string, unknown>[] = [];
  let baseId: number;

  async function cleanup() {
    await prisma.device.deleteMany({ where: { id: DEVICE } });
    await prisma.alert.deleteMany({ where: { location: { contains: DEVICE } } });
    await prisma.area.deleteMany({ where: { name: AREA } });
    await prisma.user.deleteMany({ where: { email: OWNER_EMAIL } });
  }

  beforeAll(async () => {
    // Stand-in for Supabase's REST API, honouring the id=gt.<cursor> filter.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const after = Number(url.searchParams.get('id')!.slice('gt.'.length));
      return new Response(JSON.stringify(rows.filter((r) => Number(r.id) > after)), { status: 200 });
    });

    const env = parseEnv({
      ...process.env,
      NODE_ENV: 'test',
      MQTT_URL: '',
      JWT_ACCESS_SECRET: 'e2e-secret-0123456789abcdef',
      SUPABASE_URL: 'https://ai.supabase.test',
      SUPABASE_SECRET_KEY: 'test-secret',
      AI_IMPORT_INTERVAL_S: '3600',
      CLOUDINARY_CLOUD_NAME: 'mosqai-test',
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(env)] }).compile();
    app = configureApp(moduleRef.createNestApplication(), env);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);
    importer = app.get(AiImportService);

    await cleanup();
    // Log ids continue after anything a previous run imported, like the real table's sequence.
    const max = (await prisma.image.aggregate({ _max: { aiLogId: true } }))._max.aiLogId ?? 0n;
    baseId = Number(max) + 1000;
    const owner = await prisma.user.create({
      data: { email: OWNER_EMAIL, name: 'E2E AI Owner', role: 'OWNER', passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });
    const area = await prisma.area.create({ data: { name: AREA, site: 'E2E', district: 'E2E', lat: -1.9, lng: 30 } });
    await prisma.device.create({
      data: { id: DEVICE, type: 'CAMERA_TRAP', areaId: area.id, sector: 'E2E', lat: -1.9, lng: 30, ownerId: owner.id, cameraId: CAMERA },
    });
    token = (await http.post('/v1/auth/login').send({ email: OWNER_EMAIL, password: PASSWORD }).expect(200)).body.accessToken;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (prisma) await cleanup();
    await app?.close();
  });

  it('imports frames as presence and new mosquitoes as captures', async () => {
    rows = [
      { id: baseId + 1, trap_id: CAMERA, image_uid: 'mosqai_traps/trap_E2E/f1', new_mosquitoes_count: 2, event_type: 'frame', logged_at: minutesAgo(70) },
      { id: baseId + 2, trap_id: CAMERA, image_uid: null, new_mosquitoes_count: 0, event_type: 'frame', logged_at: minutesAgo(10) },
      { id: baseId + 3, trap_id: 'NOT-LINKED', image_uid: null, new_mosquitoes_count: 5, event_type: 'frame', logged_at: minutesAgo(5) },
      { id: baseId + 4, trap_id: CAMERA, image_uid: null, new_mosquitoes_count: 0, event_type: 'reset', logged_at: minutesAgo(1) },
    ];
    await importer.sync();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: DEVICE } });
    expect(device.status).toBe('ONLINE');
    // Presence follows the newest frame, not the reset
    expect(device.lastSeenAt?.toISOString()).toBe(rows[1].logged_at);

    const captures = (await http.get(`/v1/devices/${DEVICE}/captures`).set('Authorization', `Bearer ${token}`).expect(200)).body;
    expect(captures).toHaveLength(1);
    expect(captures[0]).toMatchObject({ mosquitoes: 2, species: null, confidence: null });

    const detail = (await http.get(`/v1/captures/${captures[0].id}`).set('Authorization', `Bearer ${token}`).expect(200)).body;
    expect(detail.imageUrl).toBe('https://res.cloudinary.com/mosqai-test/image/upload/mosqai_traps/trap_E2E/f1');
    expect(detail.analysis).toMatchObject({ modelVersion: 'mosqai-v1', mosquitoes: 2 });

    const days = await prisma.captureDay.findMany({ where: { deviceId: DEVICE } });
    expect(days.reduce((n, d) => n + d.unidentified, 0)).toBe(2);
    expect(days.reduce((n, d) => n + d.other, 0)).toBe(0);
  });

  it('imports each log row only once', async () => {
    rows.push({ id: baseId + 5, trap_id: CAMERA, image_uid: null, new_mosquitoes_count: 1, event_type: 'frame', logged_at: minutesAgo(0) });
    expect(await importer.sync()).toBe(1);
    expect(await importer.sync()).toBe(0);
    expect(await prisma.image.count({ where: { deviceId: DEVICE } })).toBe(2);
  });

  it('marks the camera offline when frames stop', async () => {
    await importer.sync(new Date(Date.now() + 3 * 3600_000));
    const device = await prisma.device.findUniqueOrThrow({ where: { id: DEVICE } });
    expect(device.status).toBe('OFFLINE');
  });
});
