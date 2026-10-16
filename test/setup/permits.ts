import type { Compound } from './community';
import type { HttpHarness } from './http-app';
import { safetyHelpers, type Who } from './safety';

export type { Who } from './safety';

/** The compound's permit rules as the API returns them (ADR 0049). */
export interface PermitSettingsBody {
  workDays: number[];
  workHours: { from: string; to: string };
  daysOff: string[];
}

/**
 * Helpers for the permits suites (ADR 0049): a compound with a home and its
 * primary, the manager, guards on duty, staff holding exactly the
 * permissions a test names, and calls over HTTP.
 */
export function permitHelpers(h: HttpHarness) {
  const s = safetyHelpers(h);
  const { v, who, http } = s;

  /** A compound, its manager, and a home where `alice` lives (its primary). */
  async function setUp(name = 'Permits Court') {
    const c = await v.x.compound(name);
    const home = await v.unit(c, 'P1');
    return {
      c,
      home,
      manager: await who(c, c.managerId, 'manager'),
      alice: await v.owner(c, home.id),
    };
  }

  /** `PATCH /staff/permit-settings` as `as`: the new rules. */
  async function setRules(
    as: Who,
    body: Partial<PermitSettingsBody>,
  ): Promise<PermitSettingsBody> {
    return (
      await http('patch', '/staff/permit-settings', as.token, body).expect(200)
    ).body as PermitSettingsBody;
  }

  /** Every day, all day long: no rule refuses anything (a test's own). */
  const anyTime = (as: Who) =>
    setRules(as, {
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workHours: { from: '00:00', to: '23:59' },
      daysOff: [],
    });

  return { ...s, s, setUp, setRules, anyTime };
}

export type PermitSetUp = Awaited<
  ReturnType<ReturnType<typeof permitHelpers>['setUp']>
>;
export type { Compound };
