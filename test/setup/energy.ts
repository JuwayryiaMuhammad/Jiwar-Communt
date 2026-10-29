import { assetHelpers } from './assets';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';

export interface MeterRead {
  id: string;
  code: string;
  kind: string;
  unit: string;
  mode: string;
  multiplier: string;
  unitId: string | null;
  commonAreaId: string | null;
  assetId: string | null;
  serial: string | null;
  installedOn: string | null;
  active: boolean;
  retireReason: string | null;
}

/**
 * Helpers for the energy suites (ADR 0066): the asset set-up (a manager,
 * a maintenance supervisor, technicians, a unit with its owner, a
 * building), and meters over HTTP as the manager.
 */
export function energyHelpers(h: HttpHarness) {
  const a = assetHelpers(h);

  const setUp = (technicians = 1) => a.setUp(technicians);
  type SetUp = Awaited<ReturnType<typeof setUp>>;

  const newMeter = (s: SetUp, body: object) =>
    a.http('post', '/maintenance/meters', s.manager.token, {
      code: `M-${uniqueSuffix()}`,
      kind: 'water',
      ...body,
    });

  /** A meter in a new common area, or where `body` says; its view. */
  async function meter(s: SetUp, body: object = {}): Promise<MeterRead> {
    const place =
      'unitId' in body || 'commonAreaId' in body || 'assetId' in body
        ? {}
        : { commonAreaId: (await a.area(s)).id };
    return (await newMeter(s, { ...place, ...body }).expect(201))
      .body as MeterRead;
  }

  return { ...a, setUp, newMeter, meter };
}

export type EnergySetUp = Awaited<
  ReturnType<ReturnType<typeof energyHelpers>['setUp']>
>;
