import { auditReaders } from './audit';
import type { Compound } from './community';
import { uniqueSuffix } from './fixtures';
import { gateHelpers } from './gate';
import type { HttpHarness } from './http-app';
import { managementHelpers, type Who } from './management';

export type { Who } from './management';

export interface UnitBody {
  id: string;
  code: string;
  building: string | null;
  buildingId: string | null;
  floor: number | null;
  unitType?: string | null;
  areaSqm?: string | null;
}

export interface BuildingBody {
  id: string;
  name: string;
  units: number;
}

/** The unit register (ADR 0072): a compound, its manager, HTTP as them. */
export function unitsHelpers(h: HttpHarness) {
  const m = managementHelpers(h);
  const { x, who, http } = m;
  const g = gateHelpers(h);
  const audits = auditReaders(h);

  async function setUp(name = 'Register Court') {
    const c = await x.compound(name);
    return { c, manager: await who(c, c.managerId, 'manager') };
  }

  const newUnit = async (
    manager: Who,
    body: Record<string, unknown> = {},
  ): Promise<UnitBody> =>
    (
      await http('post', '/units', manager.token, {
        code: `U-${uniqueSuffix()}`,
        ...body,
      }).expect(201)
    ).body as UnitBody;

  const building = async (manager: Who, name: string): Promise<BuildingBody> =>
    (await http('post', '/buildings', manager.token, { name }).expect(201))
      .body as BuildingBody;

  const buildings = async (manager: Who): Promise<BuildingBody[]> =>
    (
      (await http('get', '/buildings', manager.token).expect(200)).body as {
        data: BuildingBody[];
      }
    ).data;

  const edit = (manager: Who, unitId: string, body: object) =>
    http('patch', `/units/${unitId}`, manager.token, body);

  /** The unit's row as stored, the text and the id. */
  const row = (c: Compound, unitId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.unit.findUniqueOrThrow({ where: { id: unitId } }),
    );

  return {
    ...m,
    g,
    audits,
    setUp,
    newUnit,
    building,
    buildings,
    edit,
    row,
  };
}
