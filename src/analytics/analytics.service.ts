import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module.js';
import type { Area, AreaDay, Species } from './contract.js';
import { computeAreaStats, generateInsights } from './insights.js';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const zeroSpecies = (): Record<Species, number> => ({
  ANOPHELES: 0,
  CULEX: 0,
  AEDES: 0,
  OTHER: 0,
});

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Newest complete rolled-up day: yesterday at the latest (today is still
   * filling up and would read as a sudden drop), earlier if the rollup lags.
   */
  private async lastDay(): Promise<Date> {
    const latest = await this.prisma.captureDay.aggregate({
      _max: { date: true },
    });
    const yesterday = new Date(isoDay(new Date(Date.now() - DAY)));
    const max = latest._max.date;
    return max && max < yesterday ? max : yesterday;
  }

  /**
   * Daily captures per area for the last `days` days. An area-day with no reporting
   * capture device has `captures: null` (NO_DATA), not 0.
   */
  async areaDays(days: number): Promise<AreaDay[]> {
    const end = await this.lastDay();
    const start = new Date(end.getTime() - (days - 1) * DAY);
    const areas = await this.prisma.area.findMany({
      include: {
        devices: {
          where: { type: { not: 'WEATHER_SENSOR' } },
          select: { id: true },
        },
      },
      orderBy: { name: 'asc' },
    });
    const rows = await this.prisma.captureDay.findMany({
      where: { date: { gte: start, lte: end } },
    });
    const byKey = new Map(
      rows.map((r) => [`${r.deviceId}|${isoDay(r.date)}`, r]),
    );

    const out: AreaDay[] = [];
    for (const area of areas) {
      for (let t = 0; t < days; t++) {
        const date = isoDay(new Date(start.getTime() + t * DAY));
        const reported = area.devices
          .map((d) => byKey.get(`${d.id}|${date}`))
          .filter((r) => r?.reported);
        if (reported.length === 0) {
          out.push({
            area: area.name,
            date,
            captures: null,
            bySpecies: null,
            reportingDevices: 0,
            totalDevices: area.devices.length,
          });
          continue;
        }
        const bySpecies = zeroSpecies();
        for (const r of reported) {
          bySpecies.ANOPHELES += r!.anopheles;
          bySpecies.CULEX += r!.culex;
          bySpecies.AEDES += r!.aedes;
          bySpecies.OTHER += r!.other;
        }
        out.push({
          area: area.name,
          date,
          captures:
            bySpecies.ANOPHELES +
            bySpecies.CULEX +
            bySpecies.AEDES +
            bySpecies.OTHER,
          bySpecies,
          reportingDevices: reported.length,
          totalDevices: area.devices.length,
        });
      }
    }
    return out;
  }

  /** Percentage of captures per local hour over the last `days` days (24 values). */
  async hourlyShare(days = 30): Promise<number[]> {
    const end = await this.lastDay();
    const rows = await this.prisma.captureDay.findMany({
      where: {
        reported: true,
        date: { gte: new Date(end.getTime() - (days - 1) * DAY), lte: end },
      },
      select: { hourly: true },
    });
    const totals = Array<number>(24).fill(0);
    for (const r of rows) r.hourly.forEach((n, h) => (totals[h] += n));
    const sum = totals.reduce((a, b) => a + b, 0) || 1;
    return totals.map((n) => Math.round((n / sum) * 1000) / 10);
  }

  async areas(): Promise<Area[]> {
    const [areas, week] = await Promise.all([
      this.prisma.area.findMany(),
      this.areaDays(7),
    ]);
    const counts = new Map<string, number>();
    for (const d of week)
      counts.set(d.area, (counts.get(d.area) ?? 0) + (d.captures ?? 0));
    return areas
      .map((a) => ({
        name: a.name,
        site: a.site,
        district: a.district,
        lat: a.lat,
        lng: a.lng,
        risk: a.risk,
        mosquitoCount: counts.get(a.name) ?? 0,
      }))
      .sort((a, b) => b.mosquitoCount - a.mosquitoCount);
  }

  /** Per-area stats and recommended actions: current `days` vs. the `days` before. */
  async insights(days: number) {
    const [areas, series, hourly] = await Promise.all([
      this.areas(),
      this.areaDays(days * 2),
      this.hourlyShare(),
    ]);
    const stats = computeAreaStats(areas, series, days);
    return { days, stats, insights: generateInsights(stats, hourly, days) };
  }

  /** Daily totals for the dashboard trend chart. */
  async trend(days = 6) {
    const series = await this.areaDays(days);
    const dates = [...new Set(series.map((d) => d.date))];
    const high = new Set(
      (await this.prisma.area.findMany({ where: { risk: 'HIGH' } })).map(
        (a) => a.name,
      ),
    );
    return dates.map((date) => {
      const day = series.filter((d) => d.date === date && d.captures !== null);
      return {
        date,
        total: day.reduce((a, d) => a + d.captures!, 0),
        highRisk: day
          .filter((d) => high.has(d.area))
          .reduce((a, d) => a + d.captures!, 0),
      };
    });
  }

  /**
   * Dashboard KPIs for the last 7 days vs. the 7 before (shape of the web's
   * DashboardSummary). Mosquitoes = AI-identified insects; captures = analysed
   * trap images; uptime = reported device-days / possible device-days.
   */
  async summary() {
    const end = await this.lastDay();
    const weekStart = new Date(end.getTime() - 6 * DAY);
    const prevStart = new Date(end.getTime() - 13 * DAY);
    const endOfDay = new Date(end.getTime() + DAY);
    const [rows, devices, highRiskAreas, imagesNow, imagesBefore, reports] = await Promise.all([
      this.prisma.captureDay.findMany({ where: { date: { gte: prevStart, lte: end } } }),
      this.prisma.device.findMany({ select: { status: true, type: true } }),
      this.prisma.area.count({ where: { risk: 'HIGH' } }),
      this.prisma.image.count({ where: { capturedAt: { gte: weekStart, lt: endOfDay } } }),
      this.prisma.image.count({ where: { capturedAt: { gte: prevStart, lt: weekStart } } }),
      this.prisma.report.count(),
    ]);
    const inWeek = (d: Date) => d >= weekStart;
    const mosquitoes = (current: boolean) =>
      rows
        .filter((r) => inWeek(r.date) === current && r.reported)
        .reduce((a, r) => a + r.anopheles + r.culex + r.aedes + r.other, 0);
    const traps = devices.filter((d) => d.type !== 'WEATHER_SENSOR').length || 1;
    const uptime = (current: boolean) =>
      (rows.filter((r) => inWeek(r.date) === current && r.reported).length / (traps * 7)) * 100;
    const change = (now: number, before: number) => (before ? now / before - 1 : null);
    const mNow = mosquitoes(true);
    const mBefore = mosquitoes(false);
    const uNow = uptime(true);
    const uBefore = uptime(false);
    return {
      periodStart: isoDay(weekStart),
      periodEnd: isoDay(end),
      totalMosquitoes: { value: mNow, change: change(mNow, mBefore) },
      // No history is kept for these yet: the change is unknown, not zero.
      highRiskAreas: { value: highRiskAreas, change: null },
      activeDevices: {
        value: devices.filter((d) => d.status !== 'OFFLINE').length,
        total: devices.length,
        change: null,
      },
      captures: { value: imagesNow, change: change(imagesNow, imagesBefore) },
      uptimePct: { value: Math.round(Math.min(uNow, 100) * 10) / 10, change: change(uNow, uBefore) },
      totalReports: { value: reports, change: null },
    };
  }
}
