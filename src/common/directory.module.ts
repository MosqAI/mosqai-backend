// Small read-only endpoints: reports, users, health.
import { Controller, Get, Module } from '@nestjs/common';
import { AUTHORITY_ROLES, Public, Roles } from '../auth/auth.decorators.js';
import { MqttService } from '../mqtt/mqtt.service.js';
import { PrismaService } from '../prisma/prisma.module.js';

@Controller('reports')
@Roles(...AUTHORITY_ROLES)
class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const reports = await this.prisma.report.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return reports.map((r) => ({
      id: r.id,
      date: r.createdAt,
      type: r.type,
      areas: r.areas,
      status: r.status,
    }));
  }
}

@Controller('health')
class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqtt: MqttService,
  ) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return {
      status: 'ok',
      database: 'up',
      mqtt: this.mqtt.connected ? 'up' : 'down',
    };
  }
}

@Module({ controllers: [ReportsController, HealthController] })
export class DirectoryModule {}
