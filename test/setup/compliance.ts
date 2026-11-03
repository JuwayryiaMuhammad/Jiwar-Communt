import { newId } from '../../src/core/common/uuid';
import type { Compound } from './community';
import { dbDate } from './compound-clock';
import { uniqueSuffix } from './fixtures';
import type { HttpHarness } from './http-app';
import { securityOpsHelpers } from './security-ops';

/** A compliance item as the API answers (ADR 0087). */
export interface ComplianceItemBody {
  id: string;
  kind: string;
  title: string;
  state: string;
  leadDays: number[];
  ownLeadDays: boolean;
  recurrenceMonths: number | null;
  vendor: { id: string; name: string } | null;
  owner: { id: string } | null;
  asset: { id: string; code: string } | null;
  commonArea: { id: string; code: string } | null;
  current: {
    id: string;
    dueOn: string;
    status: string;
  } | null;
  lastDone: {
    id: string;
    doneOn: string | null;
    expiresOn: string | null;
    certificateNumber: string | null;
  } | null;
  retiredAt: string | null;
  retireReason: string | null;
  occurrences: {
    id: string;
    dueOn: string;
    status: string;
    previousId: string | null;
    evidence: { id: string; fileUrl: string | null }[];
  }[];
}

/**
 * The compliance calendar's fixtures (ADR 0087): a compound with its
 * manager, a technician to answer for an item, and rows the API does not
 * make (a vendor, a common area, an asset).
 */
export function complianceHelpers(h: HttpHarness) {
  const x = securityOpsHelpers(h);

  async function setUp(name = `Compliance Court ${uniqueSuffix()}`) {
    const s = await x.setUp(name);
    const tech = await x.v.who(
      s.c,
      (await x.g.guard(s.c, 'technician')).id,
      'staff',
    );
    const vendorId = newId();
    const areaId = newId();
    const assetId = newId();
    await x.inTx(s.c, async (tx) => {
      await tx.vendor.create({
        data: {
          id: vendorId,
          tenantId: s.c.tenantId,
          number: 7001,
          name: `Fire Safe ${uniqueSuffix()}`,
        },
      });
      await tx.commonArea.create({
        data: {
          id: areaId,
          tenantId: s.c.tenantId,
          kind: 'building',
          code: `TWR-${uniqueSuffix()}`,
          building: `Tower ${uniqueSuffix()}`,
          nameAr: 'برج',
          nameEn: 'Tower',
        },
      });
      const type = await tx.assetType.findFirstOrThrow({
        where: { key: 'pump' },
      });
      await tx.asset.create({
        data: {
          id: assetId,
          tenantId: s.c.tenantId,
          code: `LIFT-${uniqueSuffix()}`,
          typeId: type.id,
          depth: 1,
          commonAreaId: areaId,
          nameAr: 'مصعد',
          nameEn: 'Lift',
        },
      });
    });
    return { ...s, tech, vendorId, areaId, assetId };
  }

  /** `POST /staff/compliance/items` as `token`. */
  function createRaw(token: string, body: Record<string, unknown>) {
    return x.http('post', '/staff/compliance/items', token, {
      kind: 'fire_system',
      title: `Civil defence certificate ${uniqueSuffix()}`,
      ...body,
    });
  }

  async function create(
    token: string,
    body: Record<string, unknown>,
  ): Promise<ComplianceItemBody> {
    const res = await createRaw(token, body);
    if (res.status !== 201)
      throw new Error(
        `compliance item: ${res.status} ${JSON.stringify(res.body)}`,
      );
    return res.body as ComplianceItemBody;
  }

  function completeRaw(
    token: string,
    occurrenceId: string,
    body: Record<string, unknown>,
  ) {
    return x.http(
      'post',
      `/staff/compliance/occurrences/${occurrenceId}/complete`,
      token,
      body,
    );
  }

  /** Moves an open due day as if it were made earlier (the API refuses a past day). */
  function setDue(c: Compound, occurrenceId: string, day: string) {
    return x.inTx(c, (tx) =>
      tx.complianceOccurrence.update({
        where: { id: occurrenceId },
        data: {
          dueOn: dbDate(day),
          leadAlertedDays: null,
          overdueNotifiedAt: null,
        },
      }),
    );
  }

  return { ...x, x, setUp, createRaw, create, completeRaw, setDue };
}
