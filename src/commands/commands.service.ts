import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.decorators.js';
import { ENV, type Env } from '../config/env.js';
import type { DeviceCommand, Prisma } from '../generated/prisma/client.js';
import { deviceTopic, MqttService } from '../mqtt/mqtt.service.js';
import { PrismaService } from '../prisma/prisma.module.js';
import { confirmedStateColumns } from '../telemetry/telemetry.service.js';

export const COMMAND_TYPES = [
  'SET_POWER',
  'SET_MODE',
  'SET_FAN',
  'SET_UV',
  'SET_CO2',
  'CAPTURE_IMAGE',
  'SYNC_SCHEDULE',
  'REBOOT',
] as const;

export const createCommandSchema = z.object({
  type: z.enum(COMMAND_TYPES),
  params: z.record(z.string(), z.unknown()).default({}),
});

const ackSchema = z.object({
  command_id: z.uuid(),
  result: z.enum(['OK', 'FAILED', 'REJECTED', 'DUPLICATE']),
  actual_state: z.record(z.string(), z.unknown()).nullish(),
  error: z.string().nullish(),
  ts: z.iso.datetime().optional(),
});

export const publicCommand = (c: DeviceCommand) => ({
  id: c.id,
  deviceId: c.deviceId,
  type: c.type,
  params: c.params,
  status: c.status,
  issuedAt: c.issuedAt,
  sentAt: c.sentAt,
  ackAt: c.ackAt,
  expiresAt: c.expiresAt,
  actualState: c.actualState,
  error: c.error,
});

/**
 * Command lifecycle (architecture.md): PENDING → SENT → CONFIRMED | FAILED | REJECTED,
 * or TIMED_OUT when no ack arrives. Success means the device confirmed, never "we sent it".
 */
@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Commands');
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit() {
    this.mqtt.on('commands/ack', (id, p) => this.onAck(id, p));
    if (this.env.MQTT_URL)
      this.sweeper = setInterval(
        () =>
          this.timeOutExpired().catch((e: unknown) =>
            this.log.warn(`Timeout sweep failed, retrying next tick: ${String(e)}`),
          ),
        5_000,
      );
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  /** Owners control their own devices; admins any. Authority roles observe only. */
  async assertCanControl(user: AuthUser, deviceId: string) {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Device not found');
    if (user.role !== 'ADMIN' && device.ownerId !== user.id)
      throw new ForbiddenException();
    return device;
  }

  async create(
    user: AuthUser,
    deviceId: string,
    input: z.infer<typeof createCommandSchema>,
  ) {
    await this.assertCanControl(user, deviceId);
    const command = await this.prisma.deviceCommand.create({
      data: {
        deviceId,
        type: input.type,
        params: input.params as Prisma.InputJsonValue,
        issuedById: user.id,
        expiresAt: new Date(Date.now() + this.env.COMMAND_ACK_TIMEOUT_S * 1000),
      },
    });
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'device.command',
        target: deviceId,
        data: { commandId: command.id, ...input } as Prisma.InputJsonValue,
      },
    });

    try {
      await this.mqtt.publish(deviceTopic(deviceId, 'commands'), {
        command_id: command.id,
        type: command.type,
        params: command.params,
        issued_at: command.issuedAt.toISOString(),
        expires_at: command.expiresAt.toISOString(),
      });
      return publicCommand(
        await this.prisma.deviceCommand.update({
          where: { id: command.id },
          data: { status: 'SENT', sentAt: new Date() },
        }),
      );
    } catch (err) {
      // Not delivered to the broker: stays PENDING and times out like any unconfirmed command.
      this.log.warn(
        `Publish failed for ${command.id}: ${(err as Error).message}`,
      );
      return publicCommand(command);
    }
  }

  async list(user: AuthUser, deviceId: string) {
    await this.assertCanControl(user, deviceId);
    const rows = await this.prisma.deviceCommand.findMany({
      where: { deviceId },
      orderBy: { issuedAt: 'desc' },
      take: 50,
    });
    return rows.map(publicCommand);
  }

  async onAck(deviceId: string, payload: unknown) {
    const ack = ackSchema.parse(payload);
    const command = await this.prisma.deviceCommand.findUnique({
      where: { id: ack.command_id },
    });
    if (!command || command.deviceId !== deviceId) {
      this.log.warn(
        `Ack for unknown command ${ack.command_id} from ${deviceId}`,
      );
      return;
    }
    // Late acks after a timeout still tell us the device's real state, so record that,
    // but a final status is never overwritten.
    const final = ['CONFIRMED', 'FAILED', 'REJECTED', 'TIMED_OUT'].includes(
      command.status,
    );
    const status =
      ack.result === 'OK' || ack.result === 'DUPLICATE'
        ? 'CONFIRMED'
        : ack.result === 'REJECTED'
          ? 'REJECTED'
          : 'FAILED';
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.deviceCommand.update({
        where: { id: command.id },
        data: final
          ? {
              actualState: (ack.actual_state ?? undefined) as
                Prisma.InputJsonValue | undefined,
            }
          : {
              status,
              ackAt: now,
              actualState: (ack.actual_state ?? undefined) as
                Prisma.InputJsonValue | undefined,
              error: ack.error ?? null,
            },
      }),
      ...(ack.actual_state
        ? [
            this.prisma.device.update({
              where: { id: deviceId },
              data: {
                ...confirmedStateColumns(ack.actual_state),
                stateUpdatedAt: now,
              },
            }),
          ]
        : []),
    ]);
  }

  /** PENDING/SENT commands past their expiry become TIMED_OUT ("unconfirmed" in the apps). */
  async timeOutExpired(now = new Date()) {
    const { count } = await this.prisma.deviceCommand.updateMany({
      where: { status: { in: ['PENDING', 'SENT'] }, expiresAt: { lt: now } },
      data: { status: 'TIMED_OUT' },
    });
    return count;
  }
}
