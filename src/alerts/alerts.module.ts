import {
  Controller,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  AUTHORITY_ROLES,
  CurrentUser,
  Roles,
  type AuthUser,
} from '../auth/auth.decorators.js';
import type { Alert } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.module.js';

const publicAlert = (a: Alert) => ({
  id: a.id,
  kind: a.kind,
  severity: a.severity,
  title: a.title,
  location: a.location,
  message: a.message,
  createdAt: a.createdAt,
  deviceId: a.deviceId ?? undefined,
  acknowledged: a.acknowledgedAt !== null,
});

@Controller('alerts')
@Roles(...AUTHORITY_ROLES)
class AlertsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list() {
    const alerts = await this.prisma.alert.findMany({
      where: { dismissedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return alerts.map(publicAlert);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @Roles('AUTHORITY_ADMIN', 'ADMIN')
  async acknowledge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return publicAlert(
      await this.update(id, {
        acknowledgedAt: new Date(),
        acknowledgedBy: user.id,
      }),
    );
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  @Roles('AUTHORITY_ADMIN', 'ADMIN')
  async dismiss(@Param('id') id: string) {
    return publicAlert(await this.update(id, { dismissedAt: new Date() }));
  }

  private async update(id: string, data: Partial<Alert>) {
    const found = await this.prisma.alert.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Alert not found');
    return this.prisma.alert.update({ where: { id }, data });
  }
}

@Module({ controllers: [AlertsController] })
export class AlertsModule {}
