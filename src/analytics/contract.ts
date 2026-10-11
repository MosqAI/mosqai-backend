// Response shapes shared with mosqai-authority-web (src/lib/types.ts). Keep in sync
// until these move to a shared package.
export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type Species = 'ANOPHELES' | 'CULEX' | 'AEDES' | 'OTHER';

export interface Area {
  name: string;
  site: string;
  district: string;
  lat: number;
  lng: number;
  mosquitoCount: number;
  risk: RiskLevel;
}

/** One area-day of AI-confirmed captures. `null` counts mean NO_DATA, never zero. */
export interface AreaDay {
  area: string;
  date: string;
  captures: number | null;
  bySpecies: Record<Species, number> | null;
  reportingDevices: number;
  totalDevices: number;
}
