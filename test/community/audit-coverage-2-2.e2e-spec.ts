import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  PHASE_2_2_COVERAGE,
} from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { MOVED_OUT } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per Phase 2.2 catalog entry (ADR 0014), each asserting actor,
 * target and changes, with no personal values (strict in tests).
 */
const covered = new Set<string>();

describe('Audit coverage — Phase 2.2', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  /** Exactly one entry for (action, target); marks the action covered. */
  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  // --------------------------------------------------------------------------
  describe('capacities (ADR 0020)', () => {
    it('occupancy.converted, residence_changed, handed_over — by the manager', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const tenant = await x.resident(c, [u.id], 'tenant');
      const [rented] = await x.occupancies(c, u.id);
      const owned = await x.asManager(c, () =>
        x.residents.convertToOwner(rented.id),
      );
      expect(await single(c, 'occupancy.converted', owned.id)).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'occupancy',
        changes: { occupancyType: { from: 'tenant', to: 'owner' } },
        metadata: {
          unitId: u.id,
          accountId: tenant.id,
          convertedFromId: rented.id,
          isPrimary: true,
        },
      });

      // A second owner, who then moves out and lets the unit.
      const other = await x.resident(c, [u.id]);
      const second = (await x.occupancies(c, u.id)).find(
        (o) => o.accountId === other.id,
      )!;
      await x.asManager(c, () => x.residents.setResidence(second.id, false));
      expect(
        await single(c, 'occupancy.residence_changed', second.id),
      ).toMatchObject({
        actorId: c.managerId,
        changes: { resides: { from: true, to: false } },
        metadata: { unitId: u.id, accountId: other.id },
      });

      await x.asManager(c, () =>
        x.residents.endOccupancy(second.id, MOVED_OUT),
      );
      await x.asManager(c, () => x.residents.recordHandover(second.id));
      expect(await single(c, 'occupancy.handed_over', second.id)).toMatchObject(
        {
          actorId: c.managerId,
          changes: { handedOver: { from: false, to: true } },
        },
      );
    });

    it('unit.closed_mode_changed — by the owner-resident primary', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      const owner = await x.resident(c, [u.id]);
      await x.as(c, { id: owner.id, type: 'resident' }, () =>
        x.residents.setUnitClosed(u.id, true),
      );
      expect(await single(c, 'unit.closed_mode_changed', u.id)).toMatchObject({
        actorType: 'account',
        actorId: owner.id,
        targetType: 'unit',
        changes: { closed: { from: false, to: true } },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('catalog completeness', () => {
    it('every Phase 2.2 entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PHASE_2_2_COVERAGE) {
        expect(all).toContain(key);
        expect(COMMUNITY_COVERAGE).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...PHASE_2_2_COVERAGE].sort());
    });
  });
});
