// Power schedules. Rules live in the database (source of truth) and are pushed
// to the device with SYNC_SCHEDULE after every change. The device runs them
// itself in AUTOMATIC mode, so they keep working when it is offline.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/auth.decorators.js';
import { CommandsModule } from '../commands/commands.module.js';
import { CommandsService } from '../commands/commands.service.js';
import { ZodPipe } from '../common/zod.pipe.js';
import type { DeviceSchedule } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.module.js';

const MAX_RULES = 20;

const ruleSchema = z.object({
  action: z.enum(['ON', 'OFF']),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM'),
  /** 0 = Sunday … 6 = Saturday; empty = every day. */
  days: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .default([])
    .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
  enabled: z.boolean().default(true),
});
const updateSchema = ruleSchema.partial();

export const publicSchedule = (s: DeviceSchedule) => ({
  id: s.id,
  action: s.action,
  time: s.time,
  days: s.days,
  enabled: s.enabled,
});

@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommandsService,
  ) {}

  private async rules(deviceId: string) {
    return this.prisma.deviceSchedule.findMany({
      where: { deviceId },
      orderBy: [{ time: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async list(user: AuthUser, deviceId: string) {
    await this.commands.assertCanControl(user, deviceId);
    return (await this.rules(deviceId)).map(publicSchedule);
  }

  async create(
    user: AuthUser,
    deviceId: string,
    input: z.infer<typeof ruleSchema>,
  ) {
    await this.commands.assertCanControl(user, deviceId);
    if (
      (await this.prisma.deviceSchedule.count({ where: { deviceId } })) >=
      MAX_RULES
    ) {
      throw new BadRequestException(
        `A device can have at most ${MAX_RULES} schedule rules`,
      );
    }
    await this.prisma.deviceSchedule.create({ data: { deviceId, ...input } });
    return this.sync(user, deviceId);
  }

  async update(
    user: AuthUser,
    deviceId: string,
    id: string,
    input: z.infer<typeof updateSchema>,
  ) {
    await this.commands.assertCanControl(user, deviceId);
    await this.findOwn(deviceId, id);
    await this.prisma.deviceSchedule.update({ where: { id }, data: input });
    return this.sync(user, deviceId);
  }

  async remove(user: AuthUser, deviceId: string, id: string) {
    await this.commands.assertCanControl(user, deviceId);
    await this.findOwn(deviceId, id);
    await this.prisma.deviceSchedule.delete({ where: { id } });
    return this.sync(user, deviceId);
  }

  private async findOwn(deviceId: string, id: string) {
    const rule = await this.prisma.deviceSchedule.findUnique({ where: { id } });
    if (!rule || rule.deviceId !== deviceId)
      throw new NotFoundException('Schedule rule not found');
    return rule;
  }

  /**
   * Sends the full enabled rule set to the device. Like any command it is only
   * applied once the device acknowledges it; the app shows the sync status.
   */
  private async sync(user: AuthUser, deviceId: string) {
    const rules = await this.rules(deviceId);
    const sync = await this.commands.create(user, deviceId, {
      type: 'SYNC_SCHEDULE',
      params: {
        timezone: 'Africa/Kigali',
        rules: rules
          .filter((r) => r.enabled)
          .map((r) => ({
            id: r.id,
            action: r.action,
            time: r.time,
            days: r.days,
          })),
      },
    });
    return { schedules: rules.map(publicSchedule), sync };
  }
}

@Controller('devices/:deviceId/schedules')
class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('deviceId') deviceId: string) {
    return this.schedules.list(user, deviceId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Body(new ZodPipe(ruleSchema)) body: z.infer<typeof ruleSchema>,
  ) {
    return this.schedules.create(user, deviceId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Param('id') id: string,
    @Body(new ZodPipe(updateSchema)) body: z.infer<typeof updateSchema>,
  ) {
    return this.schedules.update(user, deviceId, id, body);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(
    @CurrentUser() user: AuthUser,
    @Param('deviceId') deviceId: string,
    @Param('id') id: string,
  ) {
    return this.schedules.remove(user, deviceId, id);
  }
}

@Module({
  imports: [CommandsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
})
export class SchedulesModule {}
