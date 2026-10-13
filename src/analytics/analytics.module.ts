import { Controller, Get, Module, Query } from '@nestjs/common';
import { z } from 'zod';
import { AUTHORITY_ROLES, Roles } from '../auth/auth.decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { AnalyticsService } from './analytics.service.js';

const daysQuery = (max: number, fallback: number) =>
  z.object({ days: z.coerce.number().int().min(1).max(max).default(fallback) });

const areaDaysQuery = daysQuery(180, 60);
const insightsQuery = daysQuery(90, 7);

@Controller()
@Roles(...AUTHORITY_ROLES)
class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('areas')
  areas() {
    return this.analytics.areas();
  }

  @Get('analytics/summary')
  summary() {
    return this.analytics.summary();
  }

  @Get('analytics/trend')
  trend() {
    return this.analytics.trend();
  }

  @Get('analytics/area-days')
  areaDays(
    @Query(new ZodPipe(areaDaysQuery)) q: z.infer<typeof areaDaysQuery>,
  ) {
    return this.analytics.areaDays(q.days);
  }

  @Get('analytics/hourly')
  hourly() {
    return this.analytics.hourlyShare();
  }

  @Get('analytics/insights')
  insights(
    @Query(new ZodPipe(insightsQuery)) q: z.infer<typeof insightsQuery>,
  ) {
    return this.analytics.insights(q.days);
  }
}

@Module({ controllers: [AnalyticsController], providers: [AnalyticsService] })
export class AnalyticsModule {}
