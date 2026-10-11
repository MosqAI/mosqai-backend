// Endpoints for device owners (the mobile app): overview, species report,
// captures with AI results, pairing and naming their devices.
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { Species } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { publicDevice } from '../devices/devices.module.js';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Public-health risk by genus: malaria (Anopheles) and dengue (Aedes) vectors are high. */
export const SPECIES_RISK: Record<Species, 'HIGH' | 'MEDIUM' | 'UNKNOWN'> = {
  ANOPHELES: 'HIGH',
  AEDES: 'HIGH',
  CULEX: 'MEDIUM',
  OTHER: 'UNKNOWN',
};

const daysQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});
const claimSchema = z.object({
  deviceId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^MSQ-\d{3,6}$/, 'Device IDs look like MSQ-001'),
  pairingCode: z.string().trim().min(6).max(32),
  nickname: z.string().trim().min(1).max(40).optional(),
  placement: z.string().trim().min(1).max(40).optional(),
});
const renameSchema = z.object({
  nickname: z.string().trim().min(1).max(40).optional(),
  placement: z.string().trim().min(1).max(40).optional(),
});

@Injectable()
export class OwnerService {
  constructor(private readonly prisma: PrismaService) {}

  private ownedDevices(user: AuthUser) {
    return this.prisma.device.findMany({
      where: { ownerId: user.id },
      select: { id: true, status: true },
    });
  }

  private async assertOwns(user: AuthUser, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.ownerId !== user.id && user.role !== 'ADMIN')
      throw new ForbiddenException();
    return device;
  }

  /** Mobile dashboard: totals over `days` vs. the `days` before, plus a daily trend. */
  async overview(user: AuthUser, days: number) {
    const devices = await this.ownedDevices(user);
    const ids = devices.map((d) => d.id);
    const end = new Date(isoDay(new Date()));
    const start = new Date(end.getTime() - days * DAY);
    const prevStart = new Date(start.getTime() - days * DAY);

    const rollups = await this.prisma.captureDay.findMany({
      where: {
        deviceId: { in: ids },
        date: { gte: prevStart, lt: end },
        reported: true,
      },
    });
    const sumWhere = (
      from: Date,
      to: Date,
      pick: (r: (typeof rollups)[number]) => number,
    ) =>
      rollups
        .filter((r) => r.date >= from && r.date < to)
        .reduce((a, r) => a + pick(r), 0);
    const total = (r: (typeof rollups)[number]) =>
      r.anopheles + r.culex + r.aedes + r.other;
    const highRisk = (r: (typeof rollups)[number]) => r.anopheles + r.aedes;
    const change = (now: number, before: number) =>
      before ? now / before - 1 : null;

    const [images, prevImages] = await Promise.all([
      this.prisma.image.count({
        where: {
          deviceId: { in: ids },
          capturedAt: { gte: start },
          aiResults: { some: {} },
        },
      }),
      this.prisma.image.count({
        where: {
          deviceId: { in: ids },
          capturedAt: { gte: prevStart, lt: start },
          aiResults: { some: {} },
        },
      }),
    ]);

    const trend = Array.from({ length: days }, (_, i) => {
      const day = new Date(start.getTime() + i * DAY);
      const rows = rollups.filter((r) => isoDay(r.date) === isoDay(day));
      // A day with no reporting device is unknown, not zero.
      return {
        date: isoDay(day),
        captures: rows.length ? rows.reduce((a, r) => a + total(r), 0) : null,
      };
    });

    const captured = sumWhere(start, end, total);
    const prevCaptured = sumWhere(prevStart, start, total);
    const high = sumWhere(start, end, highRisk);
    const prevHigh = sumWhere(prevStart, start, highRisk);
    return {
      days,
      totalCaptured: {
        value: captured,
        change: change(captured, prevCaptured),
      },
      analyzedImages: { value: images, change: change(images, prevImages) },
      highRiskSpecies: { value: high, change: change(high, prevHigh) },
      activeDevices: {
        value: devices.filter((d) => d.status !== 'OFFLINE').length,
        total: devices.length,
      },
      trend,
    };
  }

  /** Species breakdown for the owner's devices. */
  async report(user: AuthUser, days: number) {
    const ids = (await this.ownedDevices(user)).map((d) => d.id);
    const end = new Date(isoDay(new Date()));
    const rows = await this.prisma.captureDay.findMany({
      where: {
        deviceId: { in: ids },
        reported: true,
        date: { gte: new Date(end.getTime() - days * DAY), lt: end },
      },
    });
    const bySpecies: Record<Species, number> = {
      ANOPHELES: 0,
      CULEX: 0,
      AEDES: 0,
      OTHER: 0,
    };
    for (const r of rows) {
      bySpecies.ANOPHELES += r.anopheles;
      bySpecies.CULEX += r.culex;
      bySpecies.AEDES += r.aedes;
      bySpecies.OTHER += r.other;
    }
    const total = Object.values(bySpecies).reduce((a, b) => a + b, 0);
    return {
      days,
      total,
      species: (Object.keys(bySpecies) as Species[])
        .map((species) => ({
          species,
          count: bySpecies[species],
          risk: SPECIES_RISK[species],
        }))
        .sort((a, b) => b.count - a.count),
    };
  }

  async captures(user: AuthUser, deviceId: string) {
    await this.assertOwns(user, deviceId);
    const images = await this.prisma.image.findMany({
      where: { deviceId },
      orderBy: { capturedAt: 'desc' },
      take: 50,
      include: {
        aiResults: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { detections: true },
        },
      },
    });
    return images.map((img) => {
      const top = img.aiResults[0]?.detections.sort(
        (a, b) => b.confidence - a.confidence,
      )[0];
      return {
        id: img.id,
        capturedAt: img.capturedAt,
        // null until the AI service has analysed the image
        species: top?.species ?? null,
        risk: top ? SPECIES_RISK[top.species] : null,
        confidence: top?.confidence ?? null,
        detections: img.aiResults[0]?.detections.length ?? null,
      };
    });
  }

  async capture(user: AuthUser, imageId: string) {
    const img = await this.prisma.image.findUnique({
      where: { id: imageId },
      include: {
        device: { include: { area: true } },
        aiResults: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { detections: true },
        },
      },
    });
    if (!img) throw new NotFoundException('Capture not found');
    await this.assertOwns(user, img.deviceId);
    const result = img.aiResults[0];
    const detections = (result?.detections ?? []).sort(
      (a, b) => b.confidence - a.confidence,
    );
    return {
      id: img.id,
      capturedAt: img.capturedAt,
      device: publicDevice(img.device, user),
      // Images are served through short-lived signed URLs once storage exists (M2).
      imageUrl: null,
      analysis: result
        ? {
            modelVersion: result.modelVersion,
            analysedAt: result.createdAt,
            species: detections[0]?.species ?? null,
            risk: detections[0] ? SPECIES_RISK[detections[0].species] : null,
            confidence: detections[0]?.confidence ?? null,
            detections: detections.map((d) => ({
              species: d.species,
              confidence: d.confidence,
              bbox: d.bbox,
            })),
          }
        : null,
    };
  }

  /** Pairs an unowned device using the code printed on it. */
  async claim(user: AuthUser, input: z.infer<typeof claimSchema>) {
    const device = await this.prisma.device.findUnique({
      where: { id: input.deviceId },
      include: { area: true },
    });
    const ok =
      device?.pairingCodeHash &&
      (await bcrypt.compare(input.pairingCode, device.pairingCodeHash));
    // Same error for unknown device, wrong code or already claimed: don't help guessing.
    if (!device || !ok || device.ownerId)
      throw new BadRequestException('Device ID or pairing code is not valid');
    const updated = await this.prisma.device.update({
      where: { id: device.id },
      data: {
        ownerId: user.id,
        pairingCodeHash: null,
        nickname: input.nickname,
        placement: input.placement,
      },
      include: { area: true },
    });
    await this.prisma.auditLog.create({
      data: { actorId: user.id, action: 'device.claim', target: device.id },
    });
    return publicDevice(updated, user);
  }

  async rename(
    user: AuthUser,
    deviceId: string,
    input: z.infer<typeof renameSchema>,
  ) {
    await this.assertOwns(user, deviceId);
    const updated = await this.prisma.device.update({
      where: { id: deviceId },
      data: input,
      include: { area: true },
    });
    return publicDevice(updated, user);
  }
}

@Controller()
class OwnerController {
  constructor(private readonly owner: OwnerService) {}

  @Get('me/overview')
  overview(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(daysQuery)) q: z.infer<typeof daysQuery>,
  ) {
    return this.owner.overview(user, q.days);
  }

  @Get('me/report')
  report(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(daysQuery)) q: z.infer<typeof daysQuery>,
  ) {
    return this.owner.report(user, q.days);
  }

  @Get('devices/:id/captures')
  captures(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.captures(user, id);
  }

  @Get('captures/:id')
  capture(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.owner.capture(user, id);
  }

  @Post('devices/claim')
  @HttpCode(200)
  claim(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(claimSchema)) body: z.infer<typeof claimSchema>,
  ) {
    return this.owner.claim(user, body);
  }

  @Patch('devices/:id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodPipe(renameSchema)) body: z.infer<typeof renameSchema>,
  ) {
    return this.owner.rename(user, id, body);
  }
}

@Module({ controllers: [OwnerController], providers: [OwnerService] })
export class OwnerModule {}
