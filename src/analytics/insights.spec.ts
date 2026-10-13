import { describe, expect, it } from 'vitest';
import {
  computeAreaStats,
  generateInsights,
  peakWindow,
  type AreaStat,
} from './insights.js';
import type { Area, AreaDay } from './contract.js';

const area: Area = {
  name: 'A',
  site: 'A',
  district: 'D',
  lat: 0,
  lng: 0,
  mosquitoCount: 0,
  risk: 'LOW',
};

const day = (
  date: string,
  captures: number | null,
  reporting = 2,
  anopheles = 0,
): AreaDay => ({
  area: 'A',
  date,
  captures,
  bySpecies:
    captures === null
      ? null
      : {
          ANOPHELES: anopheles,
          CULEX: captures - anopheles,
          AEDES: 0,
          OTHER: 0,
        },
  reportingDevices: captures === null ? 0 : reporting,
  totalDevices: 2,
});

describe('computeAreaStats', () => {
  it('compares rates per reporting device, not raw totals', () => {
    // Previous: 2 devices x 10/day. Current: one device offline, still 10/day on the other.
    const series = [
      day('2026-09-01', 20),
      day('2026-09-02', 20),
      day('2026-09-03', 10, 1),
      day('2026-09-04', 10, 1),
    ];
    const [s] = computeAreaStats([area], series, 2);
    expect(s.captures).toBe(20);
    expect(s.prevCaptures).toBe(40);
    expect(s.change).toBe(0); // raw totals halved, but activity per trap is unchanged
    expect(s.coverage).toBe(0.5);
  });

  it('treats missing days as unknown, not zero', () => {
    const series = [
      day('2026-09-01', 10),
      day('2026-09-02', 10),
      day('2026-09-03', null),
      day('2026-09-04', 10),
    ];
    const [s] = computeAreaStats([area], series, 2);
    expect(s.noDataDays).toBe(1);
    expect(s.rate).toBe(5);
    expect(s.daily).toEqual([null, 10]);
  });

  it('returns a null change when the previous period has no data', () => {
    const [s] = computeAreaStats(
      [area],
      [day('2026-09-01', null), day('2026-09-02', 8)],
      1,
    );
    expect(s.change).toBeNull();
  });
});

describe('peakWindow', () => {
  it('finds the shortest window holding half the activity, wrapping midnight', () => {
    const hourly = Array(24).fill(0);
    hourly[22] = 3;
    hourly[23] = 3;
    hourly[0] = 3;
    hourly[12] = 3;
    expect(peakWindow(hourly)).toMatchObject({ start: 22, end: 0 });
  });
});

describe('generateInsights', () => {
  const base: AreaStat = {
    area: 'A',
    site: 'A',
    district: 'D',
    risk: 'LOW',
    lat: 0,
    lng: 0,
    captures: 200,
    prevCaptures: 100,
    rate: 10,
    prevRate: 10,
    change: 0,
    anophelesShare: 0.1,
    prevAnophelesShare: 0.1,
    coverage: 1,
    noDataDays: 0,
    reportingNow: 2,
    totalDevices: 2,
    daily: [],
  };
  const flat = Array(24).fill(1);

  it('flags surges, vector dominance and coverage gaps, most severe first', () => {
    const insights = generateInsights(
      [
        {
          ...base,
          change: 0.5,
          rate: 15,
          anophelesShare: 0.45,
          reportingNow: 1,
        },
      ],
      flat,
      7,
    );
    expect(insights.map((i) => i.id)).toEqual([
      'surge-A',
      'vector-A',
      'coverage-A',
      'peak-window',
    ]);
  });

  it('says unknown, not zero, when no device reports', () => {
    const [gap] = generateInsights([{ ...base, reportingNow: 0 }], flat, 7);
    expect(gap.detail).toMatch(/unknown, not zero/);
  });

  it('reports declines as positive', () => {
    const insights = generateInsights(
      [{ ...base, change: -0.3, rate: 7 }],
      flat,
      7,
    );
    expect(insights.find((i) => i.id === 'decline-A')?.level).toBe('positive');
  });
});
