import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { CategoriesService } from '../../src/maintenance/categories/categories.service';
import { MaintenanceSettingsService } from '../../src/maintenance/settings/maintenance-settings.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { auditReaders } from '../setup/audit';
import {
  COMMUNITY_COVERAGE,
  FILES_COVERAGE,
  MAINTENANCE_COVERAGE,
  PHASE_2_2_COVERAGE,
  PHASE_4_COVERAGE,
} from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per maintenance catalog entry (ADR 0014, 0032): actor,
 * target, changes and metadata — and never a description, a label, a
 * comment, a note or a message.
 */
const covered = new Set<string>();

describe('Audit coverage — maintenance', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('categories and settings', () => {
    it('ticket_category.created and ticket_category.updated — by the manager', async () => {
      const c = await x.compound();
      const categories = h.moduleRef.get(CategoriesService);
      const created = await x.asManager(c, () =>
        categories.create({ key: 'pool', nameAr: 'مسبح', nameEn: 'Pool' }),
      );
      expect(
        await single(c, 'ticket_category.created', created.id),
      ).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'ticket_category',
        changes: {
          key: { from: null, to: 'pool' },
          nameAr: { from: null, to: 'مسبح' },
          nameEn: { from: null, to: 'Pool' },
          defaultPriority: { from: null, to: 'normal' },
          commonAreaAllowed: { from: null, to: true },
          active: { from: null, to: true },
        },
      });
      await x.asManager(c, () =>
        categories.update(created.id, { active: false, nameEn: 'Pool' }),
      );
      expect(
        await single(c, 'ticket_category.updated', created.id),
      ).toMatchObject({
        actorId: c.managerId,
        changes: { active: { from: true, to: false } },
      });
      // A no-op edit writes nothing.
      await x.asManager(c, () => categories.update(created.id, {}));
      await single(c, 'ticket_category.updated', created.id);
    });

    it('maintenance.settings_changed — by the manager', async () => {
      const c = await x.compound();
      await x.asManager(c, () =>
        h.moduleRef
          .get(MaintenanceSettingsService)
          .update({ autoCloseHours: 24, reopenDays: 7 }),
      );
      expect(
        await single(c, 'maintenance.settings_changed', c.tenantId),
      ).toMatchObject({
        actorId: c.managerId,
        targetType: 'tenant',
        changes: { autoCloseHours: { from: 72, to: 24 } },
      });
    });
  });

  describe('tickets', () => {
    it('ticket.created_on_behalf — codes only, never the description or the label', async () => {
      const c = await x.compound();
      const unit = await x.unit(c);
      const reporter = await x.resident(c, [unit.id]);
      const category = await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'electrical' },
        }),
      );
      const ticket = await x.asManager(c, () =>
        h.moduleRef.get(TicketsService).createOnBehalf({
          commonArea: 'AUDIT-LABEL lobby',
          categoryId: category.id,
          priority: 'urgent',
          description: 'AUDIT-DESCRIPTION flickering light',
          reporterAccountId: reporter.id,
        }),
      );
      const row = await single(c, 'ticket.created_on_behalf', ticket.id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'ticket',
        metadata: {
          categoryKey: 'electrical',
          priority: 'urgent',
          location: 'common_area',
        },
      });
      expect(JSON.stringify(row)).not.toMatch(/AUDIT-|flickering|lobby/);
      expect(JSON.stringify(row)).not.toContain(reporter.id);
    });
  });

  describe('catalog completeness', () => {
    it('every maintenance entry has a scenario above, and no other suite claims it', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of MAINTENANCE_COVERAGE) {
        expect(all).toContain(key);
        expect([
          ...COMMUNITY_COVERAGE,
          ...PHASE_2_2_COVERAGE,
          ...PHASE_4_COVERAGE,
          ...FILES_COVERAGE,
        ]).not.toContain(key);
      }
      expect([...covered].sort()).toEqual([...MAINTENANCE_COVERAGE].sort());
    });
  });
});
