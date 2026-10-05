import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { buildWorld, type World } from '../api/world';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  PARCELS_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
} from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelHelpers } from '../setup/parcels';

/**
 * One scenario per parcels catalog entry (ADR 0014, 0035): actor, target,
 * changes and metadata — ids, the carrier, the pieces, a reason code or a
 * method; never a name (the label's, a delegate's), a code or a file id.
 */
const covered = new Set<string>();

describe('Audit coverage — parcels', () => {
  let h: HttpHarness;
  let w: World;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    read = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(w.a.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  const unitCode = () =>
    w.helpers.asManager(
      w.a,
      async () =>
        (
          await w.helpers.prisma.tenant.unit.findUniqueOrThrow({
            where: { id: w.a.homeUnitId },
          })
        ).code,
    );

  describe('receiving', () => {
    it('parcel.received — by the guard on shift', async () => {
      const res = await parcelHelpers(h).receive(
        w.a.tokens.guard,
        await unitCode(),
        { carrier: 'bosta', pieces: 2, labelName: 'AUDIT-LABEL' },
      );
      expect(res.status).toBe(201);
      const { id, number } = res.body as { id: string; number: number };
      const row = await single('parcel.received', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: w.a.ids.guard,
        targetType: 'parcel',
        metadata: { carrier: 'bosta', pieces: 2, parcelNumber: number },
      });
      expect(JSON.stringify(row)).not.toContain('AUDIT-LABEL');
    });
  });

  describe('catalog completeness', () => {
    it('every parcels entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PARCELS_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
          ...MAINTENANCE_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PARCELS_COVERAGE].sort());
    });
  });
});
