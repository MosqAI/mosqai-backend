// Development seed: the same Rwanda areas, devices and alerts the authority web
// shows from its fixtures, plus 60 days of capture rollups ending yesterday.
// Wipes existing data. Never run against staging or production.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import {
  PrismaClient,
  type DeviceStatus,
  type DeviceType,
  type RiskLevel,
} from '../src/generated/prisma/client.js';

if (process.env.NODE_ENV === 'production')
  throw new Error('Refusing to seed in production');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

/** Shared dev password, documented in the README. */
export const DEV_PASSWORD = 'MosqAI-dev-2026';

const SITES: Record<string, { district: string; lat: number; lng: number }> = {
  Gicumbi: { district: 'Gicumbi', lat: -1.5763, lng: 30.0675 },
  Nyabihu: { district: 'Nyabihu', lat: -1.6539, lng: 29.5106 },
  Musanze: { district: 'Musanze', lat: -1.4998, lng: 29.6344 },
  Rubavu: { district: 'Rubavu', lat: -1.6792, lng: 29.2591 },
  Nyarugenge: { district: 'Kigali', lat: -1.9536, lng: 30.045 },
  Kicukiro: { district: 'Kigali', lat: -1.9706, lng: 30.1044 },
  Gasabo: { district: 'Kigali', lat: -1.8916, lng: 30.0997 },
  Rwamagana: { district: 'Rwamagana', lat: -1.9487, lng: 30.4347 },
  Muhanga: { district: 'Muhanga', lat: -2.0845, lng: 29.7564 },
  Bugesera: { district: 'Bugesera', lat: -2.2073, lng: 30.1512 },
  Nyanza: { district: 'Nyanza', lat: -2.3517, lng: 29.7509 },
};

// [name, site, risk, 7-day count, trend, Anopheles share]
const AREAS: [string, string, RiskLevel, number, number, number][] = [
  ['Kicukiro - Sector 3', 'Kicukiro', 'HIGH', 612, 0.45, 0.46],
  ['Nyarugenge - Center', 'Nyarugenge', 'HIGH', 498, 0.2, 0.31],
  ['Gasabo - Remera', 'Gasabo', 'MEDIUM', 421, 0.3, 0.22],
  ['Muhanga - Downtown', 'Muhanga', 'MEDIUM', 367, 0.02, 0.18],
  ['Rubavu - Gisenyi', 'Rubavu', 'LOW', 289, -0.15, 0.12],
  ['Gicumbi - Byumba', 'Gicumbi', 'MEDIUM', 244, 0.04, 0.25],
  ['Bugesera - Nyamata', 'Bugesera', 'HIGH', 236, 0.35, 0.52],
  ['Musanze - Muhoza', 'Musanze', 'MEDIUM', 198, -0.35, 0.1],
  ['Rwamagana - Kigabiro', 'Rwamagana', 'LOW', 176, 0, 0.2],
  ['Nyabihu - Mukamira', 'Nyabihu', 'MEDIUM', 154, -0.02, 0.08],
  ['Nyanza - Busasamana', 'Nyanza', 'LOW', 121, -0.1, 0.16],
  ['Gasabo - Kimironko', 'Gasabo', 'LOW', 98, 0.05, 0.15],
];

// [type, area name, status, battery]
const DEVICES: [DeviceType, string, DeviceStatus, number | null][] = [
  ['MOSQUITO_TRAP', 'Gicumbi - Byumba', 'ONLINE', 78],
  ['CAMERA_TRAP', 'Nyabihu - Mukamira', 'ONLINE', 66],
  ['WEATHER_SENSOR', 'Musanze - Muhoza', 'ONLINE', 92],
  ['MOSQUITO_TRAP', 'Rubavu - Gisenyi', 'OFFLINE', null],
  ['CAMERA_TRAP', 'Nyarugenge - Center', 'ONLINE', 87],
  ['MOSQUITO_TRAP', 'Kicukiro - Sector 3', 'ONLINE', 81],
  ['MOSQUITO_TRAP', 'Gasabo - Remera', 'ONLINE', 74],
  ['MOSQUITO_TRAP', 'Rwamagana - Kigabiro', 'ONLINE', 69],
  ['MOSQUITO_TRAP', 'Muhanga - Downtown', 'ONLINE', 58],
  ['CAMERA_TRAP', 'Bugesera - Nyamata', 'ONLINE', 90],
  ['MOSQUITO_TRAP', 'Nyanza - Busasamana', 'ONLINE', 63],
  ['MOSQUITO_TRAP', 'Kicukiro - Sector 3', 'WARNING', 18],
  ['MOSQUITO_TRAP', 'Nyarugenge - Center', 'ONLINE', 84],
  ['WEATHER_SENSOR', 'Gasabo - Remera', 'ONLINE', 96],
  ['MOSQUITO_TRAP', 'Musanze - Muhoza', 'ONLINE', 71],
  ['CAMERA_TRAP', 'Gicumbi - Byumba', 'ONLINE', 77],
  ['MOSQUITO_TRAP', 'Rubavu - Gisenyi', 'ONLINE', 88],
  ['MOSQUITO_TRAP', 'Bugesera - Nyamata', 'ONLINE', 52],
  ['MOSQUITO_TRAP', 'Muhanga - Downtown', 'ONLINE', 67],
  ['CAMERA_TRAP', 'Rwamagana - Kigabiro', 'ONLINE', 83],
  ['WEATHER_SENSOR', 'Nyabihu - Mukamira', 'OFFLINE', null],
  ['MOSQUITO_TRAP', 'Nyanza - Busasamana', 'ONLINE', 79],
  ['MOSQUITO_TRAP', 'Gasabo - Kimironko', 'ONLINE', 61],
  ['WEATHER_SENSOR', 'Kicukiro - Sector 3', 'ONLINE', 89],
  ['MOSQUITO_TRAP', 'Nyarugenge - Center', 'ONLINE', 72],
  ['MOSQUITO_TRAP', 'Gicumbi - Byumba', 'ONLINE', 85],
];

const HOURLY_SHARE = [
  3.1, 2.6, 2.2, 2.4, 3.6, 4.4, 3.0, 1.2, 0.6, 0.4, 0.3, 0.3, 0.3, 0.3, 0.4,
  0.6, 1.0, 2.4, 5.6, 9.8, 12.4, 11.6, 9.5, 7.0,
];

const DAY = 86_400_000;
const DAYS = 60;
const HOUR = 3_600_000;
const noise = (seed: number) =>
  (((Math.sin(seed * 12.9898) * 43758.5453) % 1) + 1) % 1;
const jitter = (i: number) => {
  const step = ((i * 37) % 11) - 5;
  return (step === 0 ? 3 : step) / 90;
};

/** Splits a day total across hours by HOURLY_SHARE; cumulative rounding keeps the sum exact. */
function spreadByHour(total: number): number[] {
  const sum = HOURLY_SHARE.reduce((x, y) => x + y, 0);
  let cum = 0;
  return HOURLY_SHARE.map((share) => {
    const before = Math.round((cum / sum) * total);
    cum += share;
    return Math.round((cum / sum) * total) - before;
  });
}

async function main() {
  // Children first; cascades handle the rest. One statement at a time: the
  // embedded dev database times out on a single large wipe transaction.
  await prisma.auditLog.deleteMany();
  await prisma.alert.deleteMany();
  await prisma.report.deleteMany();
  await prisma.captureDay.deleteMany();
  await prisma.image.deleteMany();
  await prisma.deviceCommand.deleteMany();
  await prisma.heartbeat.deleteMany();
  await prisma.device.deleteMany();
  await prisma.area.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.user.deleteMany();

  // A deployed database must not use the password published in the READMEs.
  const password = process.env.SEED_PASSWORD ?? DEV_PASSWORD;
  if (process.env.NODE_ENV === 'production' && password === DEV_PASSWORD)
    throw new Error('Set SEED_PASSWORD when seeding a production database');
  const passwordHash = await bcrypt.hash(password, 10);
  const staff: [
    string,
    string,
    'ADMIN' | 'AUTHORITY_ADMIN' | 'AUTHORITY_VIEWER',
    boolean,
  ][] = [
    ['Admin Authority', 'admin@rha.gov.rw', 'ADMIN', true],
    ['Dr. Jean Bosco', 'jean@rha.gov.rw', 'AUTHORITY_ADMIN', true],
    ['Aline Mukamana', 'aline@rha.gov.rw', 'AUTHORITY_VIEWER', true],
    ['Samuel Niyoncima', 'samuel@rha.gov.rw', 'AUTHORITY_ADMIN', true],
    ['Claire Uwimana', 'claire@rha.gov.rw', 'AUTHORITY_VIEWER', false],
  ];
  for (const [name, email, role, active] of staff) {
    await prisma.user.create({
      data: {
        name,
        email,
        role,
        active,
        passwordHash,
        lastLoginAt: new Date(Date.now() - 2 * DAY),
      },
    });
  }
  const pairingHash = (code: string) => bcrypt.hashSync(code, 4);
  const owner = await prisma.user.create({
    data: {
      name: 'Eric Habimana',
      email: 'owner@example.com',
      role: 'OWNER',
      passwordHash,
    },
  });

  const areaIds = new Map<string, string>();
  for (const [name, site, risk] of AREAS) {
    const s = SITES[site];
    const area = await prisma.area.create({
      data: { name, site, district: s.district, lat: s.lat, lng: s.lng, risk },
    });
    areaIds.set(name, area.id);
  }

  const now = Date.now();
  for (const [i, [type, areaName, status, batteryPct]] of DEVICES.entries()) {
    const site = AREAS.find((a) => a[0] === areaName)![1];
    await prisma.device.create({
      data: {
        id: `MSQ-${String(i + 1).padStart(3, '0')}`,
        type,
        areaId: areaIds.get(areaName)!,
        sector: `${site} - Sector ${(i % 4) + 1}`,
        status,
        batteryPct,
        lastSeenAt: new Date(
          status === 'OFFLINE' ? now - 30 * HOUR : now - 5 * 60_000,
        ),
        installedAt: new Date(now - 27 * DAY),
        nextMaintenanceAt: new Date(now + 3 * DAY),
        lat: SITES[site].lat + jitter(i),
        lng: SITES[site].lng + jitter(i + 3),
        firmware: '0.1.0',
        // The owner account holds the first two devices (for the mobile app).
        ownerId: i < 2 ? owner.id : null,
        nickname: i < 2 ? `Device ${i + 1}` : null,
        // MSQ-001 is the prototype ESP32-CAM; its frames arrive through the AI service import.
        cameraId: i === 0 ? (process.env.SEED_CAMERA_ID ?? 'TRAP-PROTOTYPE-01') : null,
        placement: i < 2 ? ['Living Room', 'Bedroom'][i] : null,
        // Unowned devices can be paired with code PAIR-<number>, e.g. PAIR-026.
        pairingCodeHash:
          i < 2 ? null : pairingHash(`PAIR-${String(i + 1).padStart(3, '0')}`),
        powerOn: type === 'WEATHER_SENSOR' ? null : status !== 'OFFLINE',
        co2LevelPct: type === 'WEATHER_SENSOR' ? null : i === 1 ? 18 : 35 + Math.round(noise(i * 13) * 60),
        mode: type === 'WEATHER_SENSOR' ? null : 'AUTOMATIC',
        fanOn: type === 'WEATHER_SENSOR' ? null : status !== 'OFFLINE',
        uvOn: type === 'WEATHER_SENSOR' ? null : status !== 'OFFLINE',
        co2On: type === 'WEATHER_SENSOR' ? null : false,
        cameraStatus: type === 'WEATHER_SENSOR' ? null : 'ok',
        stateUpdatedAt: new Date(now - 10 * 60_000),
      },
    });
  }

  // Daily rollups, ending yesterday (UTC).
  const yesterday =
    Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      new Date().getUTCDate(),
    ) - DAY;
  const rows = [];
  for (const [
    ai,
    [areaName, site, , count, trend, anopheles],
  ] of AREAS.entries()) {
    const devices = DEVICES.map((d, i) => ({
      id: `MSQ-${String(i + 1).padStart(3, '0')}`,
      type: d[0],
      area: d[1],
      status: d[2],
    })).filter((d) => d.area === areaName && d.type !== 'WEATHER_SENSOR');
    const base =
      count / 7 / (1 + Math.max(trend, 0)) / Math.max(devices.length, 1);
    for (let t = 0; t < DAYS; t++) {
      const date = new Date(yesterday - (DAYS - 1 - t) * DAY);
      const outage = site === 'Nyanza' && t >= DAYS - 10 && t <= DAYS - 8;
      const ramp = 1 + trend * Math.min(1, Math.max(0, (t - 49) / 6));
      for (const [di, d] of devices.entries()) {
        const reported = !outage && !(d.status === 'OFFLINE' && t >= DAYS - 2);
        const total = reported
          ? Math.round(
              base *
                ramp *
                (1 + 0.12 * Math.sin((t + ai) / 1.1)) *
                (0.85 + 0.3 * noise(ai * 100 + t * 7 + di)),
            )
          : 0;
        const an = Math.round(total * anopheles);
        const aedes = Math.round(total * 0.08);
        const other = Math.round(total * 0.06);
        rows.push({
          deviceId: d.id,
          date,
          reported,
          anopheles: an,
          aedes,
          other,
          culex: Math.max(0, total - an - aedes - other),
          hourly: reported ? spreadByHour(total) : Array(24).fill(0),
        });
      }
    }
  }
  await prisma.captureDay.createMany({ data: rows });

  const alerts: [
    string,
    'ACTIVITY' | 'DEVICE_OFFLINE' | 'RISK_AREA' | 'DEVICE_ONLINE',
    'HIGH' | 'MEDIUM' | 'LOW' | 'INFO',
    string,
    string,
    string,
    number,
    string?,
  ][] = [
    [
      'High mosquito activity detected',
      'ACTIVITY',
      'HIGH',
      'Kicukiro - Sector 3',
      'Elevated vector concentration reported by trap #MSQ-012',
      'Kicukiro - Sector 3',
      2,
      'MSQ-012',
    ],
    [
      'Device offline',
      'DEVICE_OFFLINE',
      'MEDIUM',
      'Device #MSQ-021 (Nyabihu)',
      'Battery critical / connection interrupted',
      'Nyabihu - Mukamira',
      4,
      'MSQ-021',
    ],
    [
      'High risk area detected',
      'RISK_AREA',
      'HIGH',
      'Nyarugenge - Center',
      'Multiple active traps exceeding threshold values',
      'Nyarugenge - Center',
      6,
    ],
    [
      'Low mosquito activity',
      'ACTIVITY',
      'LOW',
      'Rubavu - Gisenyi',
      'Normal conditions restored across residential sector',
      'Rubavu - Gisenyi',
      8,
    ],
    [
      'Device back online',
      'DEVICE_ONLINE',
      'INFO',
      'Device #MSQ-017 (Rubavu)',
      'Telemetry heartbeat resumed, solar charge nominal',
      'Rubavu - Gisenyi',
      12,
      'MSQ-017',
    ],
    [
      'High risk area detected',
      'RISK_AREA',
      'HIGH',
      'Bugesera - Nyamata',
      'Capture counts above 7-day baseline for 3 consecutive days',
      'Bugesera - Nyamata',
      20,
    ],
    [
      'Device offline',
      'DEVICE_OFFLINE',
      'MEDIUM',
      'Device #MSQ-004 (Rubavu)',
      'No heartbeat received for over 12 hours',
      'Rubavu - Gisenyi',
      26,
      'MSQ-004',
    ],
    [
      'Rising mosquito activity',
      'ACTIVITY',
      'MEDIUM',
      'Gasabo - Remera',
      'Daily captures up 30% versus last week',
      'Gasabo - Remera',
      30,
    ],
  ];
  await prisma.alert.createMany({
    data: alerts.map(
      ([
        title,
        kind,
        severity,
        location,
        message,
        area,
        hoursAgo,
        deviceId,
      ]) => ({
        title,
        kind,
        severity,
        location,
        message,
        areaId: areaIds.get(area),
        deviceId,
        createdAt: new Date(now - hoursAgo * HOUR),
      }),
    ),
  });

  const types = [
    'MOSQUITO_ACTIVITY',
    'RISK_ASSESSMENT',
    'CAPTURE',
    'SYSTEM_PERFORMANCE',
  ] as const;
  await prisma.report.createMany({
    data: Array.from({ length: 24 }, (_, i) => ({
      type: types[i % 4],
      periodStart: new Date(yesterday - (i + 7) * DAY),
      periodEnd: new Date(yesterday - i * DAY),
      areas: [12, 8, 15, 1, 10, 9, 12, 4][i % 8],
      status: 'COMPLETED' as const,
      createdAt: new Date(yesterday - i * DAY + 8 * HOUR),
    })),
  });

  // AI-analysed captures for the owner's devices (images themselves arrive with storage in M2).
  const SPECIES = ['ANOPHELES', 'CULEX', 'AEDES', 'OTHER'] as const;
  let images = 0;
  for (const deviceId of ['MSQ-001', 'MSQ-002']) {
    for (let n = 0; n < 40; n++) {
      const capturedAt = new Date(
        now - n * 8 * HOUR - Math.round(noise(n) * 3 * HOUR),
      );
      const species = SPECIES[[0, 1, 1, 2, 1, 0, 3, 1][n % 8]];
      await prisma.image.create({
        data: {
          deviceId,
          capturedAt,
          storageKey: `dev/${deviceId}/${capturedAt.toISOString()}.jpg`,
          aiResults: {
            create: {
              modelVersion: 'yolo-mosq-0.3.1',
              createdAt: new Date(capturedAt.getTime() + 40_000),
              detections: {
                create: [
                  {
                    species,
                    confidence:
                      Math.round((0.82 + noise(n + 7) * 0.17) * 100) / 100,
                    bbox: [212, 148, 320, 260],
                  },
                ],
              },
            },
          },
        },
      });
      images++;
    }
  }

  console.log(
    `Seeded ${images} analysed images,` +
      ` ${staff.length + 1} users, ${AREAS.length} areas, ${DEVICES.length} devices, ${rows.length} capture-days.`,
  );
}

await main().finally(() => prisma.$disconnect());
