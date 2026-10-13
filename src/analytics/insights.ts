// Copied verbatim from mosqai-authority-web/src/lib/analytics.ts; keep in sync.
// Area analytics and rule-based insights. Pure functions: the backend's
// analytics module will run the same rules, the web only renders the output.
import type { Area, AreaDay, RiskLevel, Species } from './contract.js';

export interface AreaStat {
  area: string;
  site: string;
  district: string;
  risk: RiskLevel;
  lat: number;
  lng: number;
  /** Sum over days with data. Unknown days are not counted as zero. */
  captures: number;
  prevCaptures: number;
  /** Captures per reporting device per day, the fair basis for comparison. */
  rate: number | null;
  prevRate: number | null;
  /** Rate change vs. the previous period; null when either side has no data. */
  change: number | null;
  anophelesShare: number | null;
  prevAnophelesShare: number | null;
  /** Device-days reported / device-days possible in the period (0..1). */
  coverage: number;
  noDataDays: number;
  reportingNow: number;
  totalDevices: number;
  /** One value per day, null = NO_DATA. */
  daily: (number | null)[];
}

export type InsightLevel = 'critical' | 'warning' | 'info' | 'positive';

export interface Insight {
  id: string;
  level: InsightLevel;
  title: string;
  detail: string;
  recommendation: string;
  area?: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function summarize(days: AreaDay[]) {
  const known = days.filter((d) => d.captures !== null);
  const captures = sum(known.map((d) => d.captures!));
  const deviceDays = sum(known.map((d) => d.reportingDevices));
  const anopheles = sum(known.map((d) => d.bySpecies?.ANOPHELES ?? 0));
  return {
    captures,
    rate: deviceDays > 0 ? captures / deviceDays : null,
    anophelesShare: captures > 0 ? anopheles / captures : null,
    deviceDays,
    possibleDeviceDays: sum(days.map((d) => d.totalDevices)),
    noDataDays: days.length - known.length,
  };
}

/** Splits each area's series into the last `days` and the `days` before, newest last. */
export function computeAreaStats(
  areas: Area[],
  series: AreaDay[],
  days: number,
): AreaStat[] {
  return areas.map((area) => {
    const all = series
      .filter((d) => d.area === area.name)
      .sort((a, b) => a.date.localeCompare(b.date));
    const current = all.slice(-days);
    const previous = all.slice(-2 * days, -days);
    const now = summarize(current);
    const before = summarize(previous);
    const last = current.at(-1);

    return {
      area: area.name,
      site: area.site,
      district: area.district,
      risk: area.risk,
      lat: area.lat,
      lng: area.lng,
      captures: now.captures,
      prevCaptures: before.captures,
      rate: now.rate,
      prevRate: before.rate,
      change:
        now.rate !== null && before.rate ? now.rate / before.rate - 1 : null,
      anophelesShare: now.anophelesShare,
      prevAnophelesShare: before.anophelesShare,
      coverage:
        now.possibleDeviceDays > 0
          ? now.deviceDays / now.possibleDeviceDays
          : 0,
      noDataDays: now.noDataDays,
      reportingNow: last?.reportingDevices ?? 0,
      totalDevices: last?.totalDevices ?? 0,
      daily: current.map((d) => d.captures),
    };
  });
}

/** Total captures per day across areas; null only when no area reported. */
export function dailyTotals(
  series: AreaDay[],
  days: number,
): { date: string; captures: number | null; anopheles: number | null }[] {
  const dates = [...new Set(series.map((d) => d.date))].sort().slice(-days);
  return dates.map((date) => {
    const known = series.filter((d) => d.date === date && d.captures !== null);
    return known.length === 0
      ? { date, captures: null, anopheles: null }
      : {
          date,
          captures: sum(known.map((d) => d.captures!)),
          anopheles: sum(known.map((d) => d.bySpecies?.ANOPHELES ?? 0)),
        };
  });
}

export function speciesTotals(
  series: AreaDay[],
  days: number,
): Record<Species, number> {
  const dates = new Set(
    [...new Set(series.map((d) => d.date))].sort().slice(-days),
  );
  const totals: Record<Species, number> = {
    ANOPHELES: 0,
    CULEX: 0,
    AEDES: 0,
    OTHER: 0,
  };
  for (const d of series) {
    if (!dates.has(d.date) || !d.bySpecies) continue;
    for (const k of Object.keys(totals) as Species[])
      totals[k] += d.bySpecies[k];
  }
  return totals;
}

/** Consecutive hours (wrapping midnight) holding the most activity, at least `minShare` of it. */
export function peakWindow(
  hourly: number[],
  minShare = 0.5,
): { start: number; end: number; share: number } {
  const total = sum(hourly) || 1;
  let best = { start: 0, end: 0, share: 0, len: 25 };
  for (let start = 0; start < 24; start++) {
    let acc = 0;
    for (let len = 1; len <= 24; len++) {
      acc += hourly[(start + len - 1) % 24];
      if (acc / total >= minShare) {
        if (len < best.len)
          best = { start, end: (start + len) % 24, share: acc / total, len };
        break;
      }
    }
  }
  return { start: best.start, end: best.end, share: best.share };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
const LEVEL_ORDER: Record<InsightLevel, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  positive: 3,
};

export function generateInsights(
  stats: AreaStat[],
  hourly: number[],
  days: number,
): Insight[] {
  const insights: Insight[] = [];
  const period = `the previous ${days} days`;

  for (const s of stats) {
    if (s.change !== null && s.change >= 0.25 && s.captures >= 50) {
      insights.push({
        id: `surge-${s.area}`,
        level: s.change >= 0.4 || s.risk === 'HIGH' ? 'critical' : 'warning',
        title: `Mosquito activity up ${pct(s.change)} in ${s.area}`,
        detail: `${s.rate!.toFixed(1)} captures per trap per day, up from ${s.prevRate!.toFixed(1)} in ${period}.`,
        recommendation:
          `Make sure every trap in ${s.area} is switched on and set to automatic, with a schedule that keeps it running from 18:00 to 06:00 while activity is high.`,
        area: s.area,
      });
    }
    if (
      s.anophelesShare !== null &&
      s.anophelesShare >= 0.4 &&
      s.captures >= 30
    ) {
      insights.push({
        id: `vector-${s.area}`,
        level: 'critical',
        title: `Malaria vectors dominate in ${s.area}`,
        detail: `Anopheles make up ${pct(s.anophelesShare)} of AI-confirmed captures${
          s.prevAnophelesShare !== null
            ? ` (was ${pct(s.prevAnophelesShare)})`
            : ''
        }.`,
        recommendation:
          `Malaria mosquitoes bite at night. Ask households in ${s.area} to keep their traps switched on from 18:00 to 06:00 every day.`,
        area: s.area,
      });
    }
    if (s.totalDevices > 0 && s.reportingNow < s.totalDevices) {
      insights.push({
        id: `coverage-${s.area}`,
        level: 'warning',
        title: `Coverage gap in ${s.area}`,
        detail:
          s.reportingNow === 0
            ? 'No device is reporting, so current activity there is unknown, not zero.'
            : `${s.reportingNow} of ${s.totalDevices} devices reporting; totals undercount the area.`,
        recommendation:
          s.reportingNow === 0
            ? `No trap in ${s.area} is on right now. Call the owners today and ask them to activate their devices; until then, treat this area as unknown.`
            : `Ask the owners in ${s.area} to switch their traps back on. Any trap still silent after a day needs a technician visit.`,
        area: s.area,
      });
    } else if (s.noDataDays > 0) {
      insights.push({
        id: `gap-${s.area}`,
        level: 'info',
        title: `${s.noDataDays} day${s.noDataDays === 1 ? '' : 's'} without data in ${s.area}`,
        detail:
          'Devices were not reporting on those days; they are excluded from rates, not counted as zero.',
        recommendation:
          `Ask the owners in ${s.area} to set an on/off schedule, so their traps switch themselves on every evening, even after a power cut.`,
        area: s.area,
      });
    }
    if (s.change !== null && s.change <= -0.25) {
      insights.push({
        id: `decline-${s.area}`,
        level: 'positive',
        title: `Activity down ${pct(-s.change)} in ${s.area}`,
        detail: `Captures per trap per day fell from ${s.prevRate!.toFixed(1)} to ${s.rate!.toFixed(1)}.`,
        recommendation:
          `Keep the traps in ${s.area} on their evening schedule so the drop holds.`,
        area: s.area,
      });
    }
  }

  const peak = peakWindow(hourly);
  insights.push({
    id: 'peak-window',
    level: 'info',
    title: `Peak biting window ${hh(peak.start)}–${hh(peak.end)}`,
    detail: `${pct(peak.share)} of captures happen in these hours across all monitored areas.`,
    recommendation:
      `Tell owners to have their traps on before ${hh(peak.start)}. The simplest way is a schedule that switches on at ${hh(peak.start)} and off at ${hh(peak.end)}.`,
  });

  return insights.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
