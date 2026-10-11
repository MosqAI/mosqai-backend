// End-to-end: real NestJS app + real Postgres (DATABASE_URL) + in-process MQTT broker.
// Fixtures use MSQ-9900xx ids and an E2E area and are removed afterwards, so dev data is untouched.
import 'dotenv/config';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Aedes } from 'aedes';
import bcrypt from 'bcryptjs';
import mqtt, { type MqttClient } from 'mqtt';
import { createServer, type Server } from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { CommandsService } from '../src/commands/commands.service.js';
import { parseEnv } from '../src/config/env.js';
import { PrismaService } from '../src/prisma/prisma.module.js';
import { TelemetryService } from '../src/telemetry/telemetry.service.js';

// Valid-format ids far outside the seeded MSQ-001..026 range.
const DEVICE = 'MSQ-990001';
const OTHER_DEVICE = 'MSQ-990002';
const AREA = 'E2E Test Area';
const PASSWORD = 'e2e-password-123';
const OWNER_EMAIL = 'e2e-owner@example.test';
const ADMIN_EMAIL = 'e2e-admin@example.test';
const STAFF_EMAIL = 'e2e-staff@example.test';
const NEW_OWNER_EMAIL = 'e2e-new-owner@example.test';
const PAIRING_CODE = 'PAIR-E2E-002';

const waitFor = async <T>(
  fn: () => Promise<T | null | undefined | false>,
  ms = 5000,
): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('device loop (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let broker: Aedes;
  let brokerServer: Server;
  let device: MqttClient;
  let http: ReturnType<typeof request>;
  let ownerToken: string;
  let adminToken: string;

  async function cleanup() {
    // Includes devices registered into the test area by the tests themselves.
    const testDevices = {
      OR: [{ id: { in: [DEVICE, OTHER_DEVICE] } }, { area: { name: AREA } }],
    };
    const ids = (
      await prisma.device.findMany({ where: testDevices, select: { id: true } })
    ).map((d) => d.id);
    await prisma.auditLog.deleteMany({ where: { target: { in: ids } } });
    await prisma.device.deleteMany({ where: { id: { in: ids } } });
    await prisma.alert.deleteMany({
      where: { location: { contains: 'MSQ-9900' } },
    });
    await prisma.area.deleteMany({ where: { name: AREA } });
    await prisma.user.deleteMany({
      where: { email: { in: [OWNER_EMAIL, ADMIN_EMAIL, NEW_OWNER_EMAIL, STAFF_EMAIL] } },
    });
  }

  beforeAll(async () => {
    broker = await Aedes.createBroker();
    brokerServer = createServer(broker.handle);
    await new Promise<void>((r) => brokerServer.listen(0, '127.0.0.1', r));
    const brokerUrl = `mqtt://127.0.0.1:${(brokerServer.address() as { port: number }).port}`;

    const env = parseEnv({
      ...process.env,
      NODE_ENV: 'test',
      MQTT_URL: brokerUrl,
      JWT_ACCESS_SECRET: 'e2e-secret-0123456789abcdef',
      COMMAND_ACK_TIMEOUT_S: '1',
      DEVICE_HEARTBEAT_TIMEOUT_S: '60',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(env)],
    }).compile();
    app = configureApp(moduleRef.createNestApplication(), env);
    await app.init();
    http = request(app.getHttpServer());
    prisma = app.get(PrismaService);

    await cleanup();
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const owner = await prisma.user.create({
      data: {
        email: OWNER_EMAIL,
        name: 'E2E Owner',
        role: 'OWNER',
        passwordHash,
      },
    });
    await prisma.user.create({
      data: {
        email: ADMIN_EMAIL,
        name: 'E2E Admin',
        role: 'ADMIN',
        passwordHash,
      },
    });
    const area = await prisma.area.create({
      data: { name: AREA, site: 'E2E', district: 'E2E', lat: -1.9, lng: 30 },
    });
    for (const id of [DEVICE, OTHER_DEVICE]) {
      await prisma.device.create({
        data: {
          id,
          type: 'MOSQUITO_TRAP',
          areaId: area.id,
          sector: 'E2E - Sector 1',
          lat: -1.9,
          lng: 30,
          ownerId: id === DEVICE ? owner.id : null,
          pairingCodeHash:
            id === OTHER_DEVICE ? await bcrypt.hash(PAIRING_CODE, 4) : null,
        },
      });
    }

    ownerToken = (
      await http
        .post('/v1/auth/login')
        .send({ email: OWNER_EMAIL, password: PASSWORD })
        .expect(200)
    ).body.accessToken;
    adminToken = (
      await http
        .post('/v1/auth/login')
        .send({ email: ADMIN_EMAIL, password: PASSWORD })
        .expect(200)
    ).body.accessToken;

    // Wait for the backend's MQTT subscription before devices start talking.
    await waitFor(async () => (await http.get('/health')).body.mqtt === 'up');
    device = await mqtt.connectAsync(brokerUrl, { clientId: 'e2e-device' });
  });

  afterAll(async () => {
    await device?.endAsync();
    if (prisma) await cleanup();
    await app?.close();
    await new Promise<void>((r) =>
      broker.close(() => brokerServer.close(() => r())),
    );
  });

  describe('auth', () => {
    it('rejects a wrong password without revealing whether the email exists', async () => {
      const wrong = await http
        .post('/v1/auth/login')
        .send({ email: OWNER_EMAIL, password: 'nope' })
        .expect(401);
      const unknown = await http
        .post('/v1/auth/login')
        .send({ email: 'nobody@example.test', password: 'nope' })
        .expect(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('rotates refresh tokens and revokes the family when an old one is reused', async () => {
      const login = await http
        .post('/v1/auth/login')
        .send({ email: OWNER_EMAIL, password: PASSWORD })
        .expect(200);
      const first = login.body.refreshToken;
      const rotated = await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: first })
        .expect(200);
      expect(rotated.body.refreshToken).not.toBe(first);

      await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: first })
        .expect(401); // reuse
      await http
        .post('/v1/auth/refresh')
        .send({ refreshToken: rotated.body.refreshToken })
        .expect(401); // family revoked
    });

    it('requires a token', async () => {
      await http.get('/v1/devices').expect(401);
    });
  });

  describe('access control', () => {
    it('shows owners only their own devices, without owner identities', async () => {
      const res = await http
        .get('/v1/devices')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body.map((d: { id: string }) => d.id)).toEqual([DEVICE]);
      expect(res.body[0]).not.toHaveProperty('ownerId');
      await http
        .get(`/v1/devices/${OTHER_DEVICE}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);
    });

    it('keeps analytics for authority roles', async () => {
      await http
        .get('/v1/analytics/insights')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(403);
      await http
        .get('/v1/analytics/insights')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
    });

    it('does not let an owner command a device they do not own', async () => {
      await http
        .post(`/v1/devices/${OTHER_DEVICE}/commands`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'SET_FAN', params: { on: false } })
        .expect(403);
    });
  });

  describe('telemetry', () => {
    it('marks a device online when its heartbeat arrives', async () => {
      await device.publishAsync(
        `mosqai/v1/devices/${DEVICE}/heartbeat`,
        JSON.stringify({
          ts: new Date().toISOString(),
          fw: '0.1.0',
          rssi: -60,
          voltage_v: 11.9,
          battery_pct: 74,
        }),
        { qos: 1 },
      );
      const updated = await waitFor(async () => {
        const d = await prisma.device.findUnique({ where: { id: DEVICE } });
        return d?.status === 'ONLINE' && d;
      });
      expect(updated.batteryPct).toBe(74);
      expect(
        await prisma.heartbeat.count({ where: { deviceId: DEVICE } }),
      ).toBe(1);
    });

    it('stores the CO2 level and counts today as a reported day', async () => {
      await device.publishAsync(
        `mosqai/v1/devices/${DEVICE}/heartbeat`,
        JSON.stringify({ ts: new Date().toISOString(), co2_pct: 23 }),
        { qos: 1 },
      );
      const updated = await waitFor(async () => {
        const d = await prisma.device.findUnique({ where: { id: DEVICE } });
        return d?.co2LevelPct === 23 && d;
      });
      expect(updated.co2LevelPct).toBe(23);
      const days = await prisma.captureDay.findMany({ where: { deviceId: DEVICE } });
      expect(days).toHaveLength(1);
      expect(days[0].reported).toBe(true);
    });

    it('adds analysed captures to the image log and the daily rollup', async () => {
      const ts = new Date().toISOString();
      await device.publishAsync(
        `mosqai/v1/devices/${DEVICE}/captures`,
        JSON.stringify({
          ts,
          detections: [
            { species: 'ANOPHELES', confidence: 0.91 },
            { species: 'CULEX', confidence: 0.88 },
          ],
        }),
        { qos: 1 },
      );
      const day = await waitFor(async () => {
        const rows = await prisma.captureDay.findMany({ where: { deviceId: DEVICE } });
        return rows[0]?.anopheles === 1 && rows[0];
      });
      expect(day.culex).toBe(1);
      expect(day.hourly.reduce((a, b) => a + b, 0)).toBe(2);
      expect(await prisma.image.count({ where: { deviceId: DEVICE } })).toBe(1);
    });

    it('marks silent devices offline, raises an alert, and forgets the battery level', async () => {
      await prisma.device.update({
        where: { id: DEVICE },
        data: {
          status: 'ONLINE',
          lastSeenAt: new Date(Date.now() - 5 * 60_000),
          batteryPct: 74,
        },
      });
      // Two minutes on, the earlier heartbeat is past the timeout too.
      const marked = await app
        .get(TelemetryService)
        .markStaleDevicesOffline(new Date(Date.now() + 120_000));
      expect(marked).toContain(DEVICE);
      const d = await prisma.device.findUniqueOrThrow({
        where: { id: DEVICE },
      });
      expect(d.status).toBe('OFFLINE');
      expect(d.batteryPct).toBeNull(); // unknown, not 0
      expect(
        await prisma.alert.count({
          where: { deviceId: DEVICE, kind: 'DEVICE_OFFLINE' },
        }),
      ).toBe(1);
    });
  });

  describe('commands', () => {
    it('is only CONFIRMED once the device acknowledges, and records the actual state', async () => {
      await device.subscribeAsync(`mosqai/v1/devices/${DEVICE}/commands`, {
        qos: 1,
      });
      const received = new Promise<{ command_id: string; type: string }>(
        (resolve) =>
          device.once('message', (_t, buf) =>
            resolve(JSON.parse(buf.toString())),
          ),
      );

      const created = await http
        .post(`/v1/devices/${DEVICE}/commands`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'SET_FAN', params: { on: false } })
        .expect(201);
      expect(created.body.status).toBe('SENT'); // sent is not success

      const cmd = await received;
      expect(cmd).toMatchObject({
        command_id: created.body.id,
        type: 'SET_FAN',
      });
      await device.publishAsync(
        `mosqai/v1/devices/${DEVICE}/commands/ack`,
        JSON.stringify({
          command_id: cmd.command_id,
          result: 'OK',
          actual_state: { fan: false, uv: true },
          error: null,
        }),
        { qos: 1 },
      );

      const confirmed = await waitFor(async () => {
        const c = await prisma.deviceCommand.findUnique({
          where: { id: cmd.command_id },
        });
        return c?.status === 'CONFIRMED' && c;
      });
      expect(confirmed.actualState).toEqual({ fan: false, uv: true });
      const detail = await http
        .get(`/v1/devices/${DEVICE}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.confirmedState).toMatchObject({
        fan: false,
        uv: true,
      });
      await device.unsubscribeAsync(`mosqai/v1/devices/${DEVICE}/commands`);
    });

    it('times out commands the device never acknowledges', async () => {
      const created = await http
        .post(`/v1/devices/${DEVICE}/commands`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ type: 'SET_UV', params: { on: false } })
        .expect(201);
      await new Promise((r) => setTimeout(r, 1100)); // COMMAND_ACK_TIMEOUT_S=1
      await app.get(CommandsService).timeOutExpired();
      const c = await prisma.deviceCommand.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(c.status).toBe('TIMED_OUT');
    });

    it('confirms power with the state the device reports', async () => {
      const topic = `mosqai/v1/devices/${DEVICE}/commands`;
      await device.subscribeAsync(topic, { qos: 1 });
      const received = new Promise<{ command_id: string; type: string }>(
        (resolve) =>
          device.once('message', (_t, buf) =>
            resolve(JSON.parse(buf.toString())),
          ),
      );
      await http
        .post(`/v1/devices/${DEVICE}/commands`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'SET_POWER', params: { on: false } })
        .expect(201);
      const cmd = await received;
      expect(cmd.type).toBe('SET_POWER');
      await device.publishAsync(
        `mosqai/v1/devices/${DEVICE}/commands/ack`,
        JSON.stringify({
          command_id: cmd.command_id,
          result: 'OK',
          actual_state: { power: false, fan: false, uv: false },
        }),
        { qos: 1 },
      );
      await waitFor(
        async () =>
          (await prisma.device.findUnique({ where: { id: DEVICE } }))
            ?.powerOn === false,
      );
      const detail = await http
        .get(`/v1/devices/${DEVICE}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(detail.body.confirmedState).toMatchObject({
        power: false,
        fan: false,
      });
      await device.unsubscribeAsync(topic);
    });

    it('stores power schedules and syncs the enabled rules to the device', async () => {
      const auth = { Authorization: `Bearer ${ownerToken}` };
      const base = `/v1/devices/${DEVICE}/schedules`;
      const topic = `mosqai/v1/devices/${DEVICE}/commands`;
      await device.subscribeAsync(topic, { qos: 1 });
      const syncs: {
        type: string;
        params: { timezone: string; rules: { action: string; time: string }[] };
      }[] = [];
      const onMessage = (_t: string, buf: Buffer) =>
        syncs.push(JSON.parse(buf.toString()));
      device.on('message', onMessage);

      await http
        .post(base)
        .set(auth)
        .send({ action: 'ON', time: '25:00' })
        .expect(400);
      await http
        .post(`/v1/devices/${OTHER_DEVICE}/schedules`)
        .set(auth)
        .send({ action: 'ON', time: '18:00' })
        .expect(403);

      const on = await http
        .post(base)
        .set(auth)
        .send({ action: 'ON', time: '18:00', days: [5, 1, 1] })
        .expect(201);
      expect(on.body.sync.type).toBe('SYNC_SCHEDULE');
      expect(on.body.schedules[0]).toMatchObject({
        action: 'ON',
        time: '18:00',
        days: [1, 5],
        enabled: true,
      });
      const off = await http
        .post(base)
        .set(auth)
        .send({ action: 'OFF', time: '06:00' })
        .expect(201);
      const offId = off.body.schedules.find(
        (r: { action: string }) => r.action === 'OFF',
      ).id;

      // Disabled rules stay stored but are not sent to the device.
      await http
        .patch(`${base}/${offId}`)
        .set(auth)
        .send({ enabled: false })
        .expect(200);
      const listed = await http.get(base).set(auth).expect(200);
      expect(listed.body).toHaveLength(2);

      await waitFor(async () => syncs.length >= 3);
      expect(syncs.at(-1)!.params).toMatchObject({
        timezone: 'Africa/Kigali',
        rules: [{ action: 'ON', time: '18:00' }],
      });

      await http.delete(`${base}/${offId}`).set(auth).expect(200);
      expect((await http.get(base).set(auth)).body).toHaveLength(1);
      device.off('message', onMessage);
      await device.unsubscribeAsync(topic);
    });

    it('validates command input', async () => {
      await http
        .post(`/v1/devices/${DEVICE}/commands`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ type: 'SELF_DESTRUCT' })
        .expect(400);
    });
  });

  describe('analytics', () => {
    it('reports area-days with no reporting device as NO_DATA (null), not zero', async () => {
      const res = await http
        .get('/v1/analytics/area-days?days=3')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const ours = res.body.filter((d: { area: string }) => d.area === AREA);
      expect(ours).toHaveLength(3);
      // Analytics cover complete days only; the test device first reported today.
      for (const day of ours)
        expect(day).toMatchObject({
          captures: null,
          reportingDevices: 0,
          totalDevices: 2,
        });
    });
  });
  describe('owner app', () => {
    let newOwnerToken: string;

    it('lets people sign up as device owners only', async () => {
      const res = await http
        .post('/v1/auth/register')
        .send({
          name: 'New Owner',
          email: NEW_OWNER_EMAIL,
          password: 'long-enough-pw',
        })
        .expect(201);
      expect(res.body.user.role).toBe('OWNER');
      newOwnerToken = res.body.accessToken;
      await http
        .post('/v1/auth/register')
        .send({
          name: 'Again',
          email: NEW_OWNER_EMAIL,
          password: 'long-enough-pw',
        })
        .expect(409);
    });

    it('pairs a device only with the right code, once, and keeps owner labels private', async () => {
      const claim = (pairingCode: string) =>
        http
          .post('/v1/devices/claim')
          .set('Authorization', `Bearer ${newOwnerToken}`)
          .send({
            deviceId: OTHER_DEVICE.toLowerCase(),
            pairingCode,
            nickname: 'Porch trap',
          });

      await claim('wrong-code').expect(400);
      const ok = await claim(PAIRING_CODE).expect(200);
      expect(ok.body).toMatchObject({
        id: OTHER_DEVICE,
        nickname: 'Porch trap',
      });
      await claim(PAIRING_CODE).expect(400); // already claimed; code cleared

      const asAdmin = await http
        .get(`/v1/devices/${OTHER_DEVICE}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      expect(asAdmin.body).not.toHaveProperty('nickname');
    });

    it('lets authority admins register a trap that an owner then pairs with the one-time code', async () => {
      await http
        .post('/v1/devices')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          type: 'MOSQUITO_TRAP',
          areaName: AREA,
          sector: 'E2E - Sector 9',
        })
        .expect(403);

      const reg = await http
        .post('/v1/devices')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'MOSQUITO_TRAP',
          areaName: AREA,
          sector: 'E2E - Sector 9',
        })
        .expect(201);
      const id: string = reg.body.device.id;
      try {
        expect(reg.body.device).toMatchObject({
          status: 'OFFLINE',
          batteryPct: null,
          lastSeenAt: null,
        });
        expect(reg.body.pairingCode).toMatch(/^PAIR-[A-Z2-9]{6}$/);
        const stored = await prisma.device.findUniqueOrThrow({ where: { id } });
        expect(stored.pairingCodeHash).not.toContain(reg.body.pairingCode); // only the hash is kept

        await http
          .post('/v1/devices/claim')
          .set('Authorization', `Bearer ${newOwnerToken}`)
          .send({ deviceId: id, pairingCode: reg.body.pairingCode })
          .expect(200);
      } finally {
        await prisma.auditLog.deleteMany({ where: { target: id } });
        await prisma.device.delete({ where: { id } });
      }
    });

    it('returns an overview where days without reports are unknown', async () => {
      const res = await http
        .get('/v1/me/overview?days=3')
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body.activeDevices.total).toBe(1);
      expect(res.body.trend).toHaveLength(3);
      for (const day of res.body.trend) expect(day.captures).toBeNull();
    });
  });

  describe('staff accounts', () => {
    let staffId: string;
    let temporary: string;

    it('lets a super admin create an account with a temporary password', async () => {
      const res = await http
        .post('/v1/users')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'E2E Staff', email: STAFF_EMAIL, role: 'AUTHORITY_VIEWER' })
        .expect(201);
      // No SMTP in tests: the email goes to the outbox and the admin gets the password.
      expect(res.body.emailed).toBe(false);
      expect(res.body.temporaryPassword).toHaveLength(12);
      expect(res.body.user).toMatchObject({ role: 'AUTHORITY_VIEWER', mustChangePassword: true });
      staffId = res.body.user.id;
      temporary = res.body.temporaryPassword;
    });

    it('keeps account management to super admins', async () => {
      const login = await http.post('/v1/auth/login').send({ email: STAFF_EMAIL, password: temporary }).expect(200);
      expect(login.body.user.mustChangePassword).toBe(true);
      await http.get('/v1/users').set('Authorization', `Bearer ${login.body.accessToken}`).expect(403);
      await http.get('/v1/areas').set('Authorization', `Bearer ${login.body.accessToken}`).expect(200);
    });

    it('replaces the temporary password on first sign-in', async () => {
      const login = await http.post('/v1/auth/login').send({ email: STAFF_EMAIL, password: temporary }).expect(200);
      const changed = await http
        .post('/v1/auth/change-password')
        .set('Authorization', `Bearer ${login.body.accessToken}`)
        .send({ currentPassword: temporary, newPassword: 'a-new-long-password' })
        .expect(200);
      expect(changed.body.user.mustChangePassword).toBe(false);
      await http.post('/v1/auth/login').send({ email: STAFF_EMAIL, password: temporary }).expect(401);
      await http.post('/v1/auth/login').send({ email: STAFF_EMAIL, password: 'a-new-long-password' }).expect(200);
    });

    it('signs a deactivated person out and blocks sign-in', async () => {
      await http.patch(`/v1/users/${staffId}`).set('Authorization', `Bearer ${adminToken}`).send({ active: false }).expect(200);
      await http.post('/v1/auth/login').send({ email: STAFF_EMAIL, password: 'a-new-long-password' }).expect(401);
    });
  });
});
