import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { auditReaders } from '../setup/audit';
import { COMMUNITY_COVERAGE } from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per Phase 2 community catalog entry (ADR 0014, 0016, 0017),
 * each asserting actor, target and changes. The rest of the catalog is
 * covered by test/audit/audit-coverage.e2e-spec.ts (see audit-coverage-split).
 */
const covered = new Set<string>();

describe('Audit coverage — community', () => {
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
  describe('primary resident', () => {
    it('occupancy.primary_changed and unit.household_review_flagged — by the manager', async () => {
      const c = await x.compound();
      const u = await x.unit(c);
      await x.resident(c, [u.id]);
      const second = await x.resident(c, [u.id], 'tenant');
      const view = await x.asManager(c, () =>
        x.residents.setPrimary(u.id, second.id),
      );

      const changed = await single(c, 'occupancy.primary_changed', view.id);
      expect(changed).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'occupancy',
        changes: { isPrimary: { from: false, to: true } },
      });

      await x.asManager(c, () => x.residents.endOccupancy(view.id));
      const flagged = await single(c, 'unit.household_review_flagged', u.id);
      expect(flagged).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'unit',
        changes: { needsHouseholdReview: { from: false, to: true } },
        metadata: { reason: 'primary_left', occupancyId: view.id },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('settings', () => {
    it('tenant.settings_changed — by the manager, values recorded', async () => {
      const c = await x.compound();
      await x.asManager(c, () =>
        h.moduleRef
          .get(TenantSettingsService)
          .update({ familyJoinRequiresApproval: true }),
      );
      const entry = await single(c, 'tenant.settings_changed', c.tenantId);
      expect(entry).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'tenant',
        changes: { familyJoinRequiresApproval: { from: false, to: true } },
      });
    });
  });

  // --------------------------------------------------------------------------
  describe('catalog completeness', () => {
    it('every community catalog entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of COMMUNITY_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...COMMUNITY_COVERAGE].sort());
    });
  });
});
