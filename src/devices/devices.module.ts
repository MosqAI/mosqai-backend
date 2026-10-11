import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { CurrentUser, Roles, type AuthUser } from '../auth/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Area, Device } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.module.js';

/** Public device shape. Owner identity is deliberately left out (architecture: privacy by default). */
export const publicDevice = (
  d: Device & { area: Area },
  viewer?: AuthUser,
) => ({
  id: d.id,
  // Owner-entered labels can reveal a home layout, so only the owner sees them.
  ...(viewer &&
    d.ownerId === viewer.id && {
      nickname: d.nickname,
      placement: d.placement,
    }),
  type: d.type,
  area: d.area.site,
  areaName: d.area.name,
  sector: d.sector,
  status: d.status,
  batteryPct: d.batteryPct,
  co2LevelPct: d.co2LevelPct,
  lastSeenAt: d.lastSeenAt,
  installedAt: d.installedAt,
  nextMaintenanceAt: d.nextMaintenanceAt,
  lat: d.lat,
  lng: d.lng,
  firmware: d.firmware,
  confirmedState: {
    mode: d.mode,
    power: d.powerOn,
    fan: d.fanOn,
    uv: d.uvOn,
    co2: d.co2On,
    camera: d.cameraStatus,
    updatedAt: d.stateUpdatedAt,
  },
});

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Owners see their own devices; authority roles and admins see all. */
  private scope(user: AuthUser) {
    return user.role === 'OWNER' ? { ownerId: user.id } : {};
  }

  async list(user: AuthUser) {
    const devices = await this.prisma.device.findMany({
      where: this.scope(user),
      include: { area: true },
      orderBy: { id: 'asc' },
    });
    return devices.map((d) => publicDevice(d, user));
  }

  async get(user: AuthUser, id: string) {
    const device = await this.prisma.device.findUnique({
      where: { id },
      include: { area: true },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (user.role === 'OWNER' && device.ownerId !== user.id)
      throw new ForbiddenException();
    return publicDevice(device, user);
  }

  async register(user: AuthUser, input: z.infer<typeof registerDeviceSchema>) {
    const area = await this.prisma.area.findUnique({
      where: { name: input.areaName },
    });
    if (!area) throw new BadRequestException('Unknown area');
    const pairingCode = newPairingCode();
    // Next sequential id; the unique primary key makes a concurrent clash fail loudly.
    const ids = await this.prisma.device.findMany({
      where: { id: { startsWith: 'MSQ-' } },
      select: { id: true },
    });
    const next =
      Math.max(
        0,
        ...ids
          .map((d) => Number(d.id.slice(4)))
          .filter((n) => Number.isFinite(n) && n < 900000),
      ) + 1;
    const device = await this.prisma.device.create({
      data: {
        id: `MSQ-${String(next).padStart(3, '0')}`,
        type: input.type,
        areaId: area.id,
        sector: input.sector,
        lat: input.lat ?? area.lat,
        lng: input.lng ?? area.lng,
        // Not reporting yet: offline, battery unknown, never seen.
        status: 'OFFLINE',
        pairingCodeHash: await bcrypt.hash(pairingCode, 10),
        nextMaintenanceAt: new Date(Date.now() + 30 * 86_400_000),
      },
      include: { area: true },
    });
    await this.prisma.auditLog.create({
      data: { actorId: user.id, action: 'device.register', target: device.id },
    });
    return { device: publicDevice(device, user), pairingCode };
  }

  /** Recent days the device synced captures (newest first). */
  async syncs(user: AuthUser, id: string) {
    await this.get(user, id);
    const days = await this.prisma.captureDay.findMany({
      where: { deviceId: id, reported: true },
      orderBy: { date: 'desc' },
      take: 5,
    });
    return days.map((d) => ({
      at: d.date,
      captures: d.anopheles + d.culex + d.aedes + d.other,
    }));
  }
}

export const registerDeviceSchema = z.object({
  type: z.enum(['MOSQUITO_TRAP', 'CAMERA_TRAP', 'WEATHER_SENSOR']),
  areaName: z.string().trim().min(1),
  sector: z.string().trim().min(1).max(80),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

/** Unambiguous characters only (no 0/O, 1/I), so codes read cleanly off a label. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newPairingCode = () =>
  `PAIR-${Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')}`;

@Controller('devices')
class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.devices.list(user);
  }

  /** Registers a new trap. The pairing code is returned once and only its hash is stored. */
  @Post()
  @Roles('AUTHORITY_ADMIN', 'ADMIN')
  register(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(registerDeviceSchema))
    body: z.infer<typeof registerDeviceSchema>,
  ) {
    return this.devices.register(user, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.devices.get(user, id);
  }

  @Get(':id/syncs')
  syncs(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.devices.syncs(user, id);
  }
}

@Module({ controllers: [DevicesController], providers: [DevicesService] })
export class DevicesModule {}
