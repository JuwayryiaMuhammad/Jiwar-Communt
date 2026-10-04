import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { CategoriesService } from '../../src/maintenance/categories/categories.service';
import { SpecialtiesService } from '../../src/maintenance/specialties/specialties.service';
import { MaintenanceSettingsService } from '../../src/maintenance/settings/maintenance-settings.service';
import { ConfirmationService } from '../../src/maintenance/tickets/confirmation.service';
import { DispatchService } from '../../src/maintenance/tickets/dispatch.service';
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
import { gateHelpers } from '../setup/gate';
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

  describe('specialties', () => {
    it('specialty.created and specialty.updated — keys and names, by the manager', async () => {
      const c = await x.compound();
      const specialties = h.moduleRef.get(SpecialtiesService);
      const created = await x.asManager(c, () =>
        specialties.create({ key: 'pool', nameAr: 'مسبح', nameEn: 'Pool' }),
      );
      expect(await single(c, 'specialty.created', created.id)).toMatchObject({
        actorType: 'account',
        actorId: c.managerId,
        targetType: 'specialty',
        changes: {
          key: { from: null, to: 'pool' },
          nameEn: { from: null, to: 'Pool' },
          active: { from: null, to: true },
        },
      });
      await x.asManager(c, () =>
        specialties.update(created.id, { active: false }),
      );
      expect(await single(c, 'specialty.updated', created.id)).toMatchObject({
        actorId: c.managerId,
        changes: { active: { from: true, to: false } },
      });
      // A no-op edit writes nothing.
      await x.asManager(c, () => specialties.update(created.id, {}));
      await single(c, 'specialty.updated', created.id);
    });

    it('ticket_category.specialties_changed and technician.specialties_changed — the keys before and after', async () => {
      const c = await x.compound();
      const specialties = h.moduleRef.get(SpecialtiesService);
      const technician = await gateHelpers(h).guard(c, 'technician');
      const all = await x.asManager(c, () => specialties.list());
      const id = (key: string) => all.find((r) => r.key === key)!.id;
      const category = await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'general' },
        }),
      );
      await x.asManager(c, () =>
        specialties.setForCategory(category.id, [id('plumbing'), id('ac')]),
      );
      expect(
        await single(c, 'ticket_category.specialties_changed', category.id),
      ).toMatchObject({
        actorId: c.managerId,
        targetType: 'ticket_category',
        changes: {
          specialties: { from: ['general'], to: ['ac', 'plumbing'] },
        },
      });
      await x.asManager(c, () =>
        specialties.setForTechnician(technician.id, [id('electrical')]),
      );
      expect(
        await single(c, 'technician.specialties_changed', technician.id),
      ).toMatchObject({
        actorId: c.managerId,
        targetType: 'account',
        changes: { specialties: { from: [], to: ['electrical'] } },
      });
      // The same set again writes nothing.
      await x.asManager(c, () =>
        specialties.setForTechnician(technician.id, [id('electrical')]),
      );
      await single(c, 'technician.specialties_changed', technician.id);
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

  describe('dispatch', () => {
    it('ticket.priority_changed — the change and its reason code', async () => {
      const c = await x.compound();
      const unit = await x.unit(c);
      const reporter = await x.resident(c, [unit.id]);
      const category = await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'plumbing' },
        }),
      );
      const ticket = await x.as(c, { id: reporter.id, type: 'resident' }, () =>
        h.moduleRef.get(TicketsService).create({
          unitId: unit.id,
          categoryId: category.id,
          description: 'AUDIT-DESCRIPTION',
        }),
      );
      await x.asManager(c, () =>
        h.moduleRef
          .get(DispatchService)
          .changePriority(ticket.id, 'urgent', 'safety_risk'),
      );
      const row = await single(c, 'ticket.priority_changed', ticket.id);
      expect(row).toMatchObject({
        actorId: c.managerId,
        targetType: 'ticket',
        changes: { priority: { from: 'normal', to: 'urgent' } },
        metadata: { reasonCode: 'safety_risk' },
      });
      expect(JSON.stringify(row)).not.toContain('AUDIT-');
    });
  });

  describe('confirmation', () => {
    it('ticket.cancelled — by the reporter and by a dispatcher, codes only', async () => {
      const c = await x.compound();
      const unit = await x.unit(c);
      const reporter = await x.resident(c, [unit.id]);
      const category = await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'ac' },
        }),
      );
      const open = () =>
        x.as(c, { id: reporter.id, type: 'resident' }, () =>
          h.moduleRef.get(TicketsService).create({
            unitId: unit.id,
            categoryId: category.id,
            description: 'AUDIT-DESCRIPTION',
          }),
        );
      const confirmation = h.moduleRef.get(ConfirmationService);
      const mine = await open();
      await x.as(c, { id: reporter.id, type: 'resident' }, () =>
        confirmation.cancelByReporter(mine.id, 'duplicate'),
      );
      expect(await single(c, 'ticket.cancelled', mine.id)).toMatchObject({
        actorId: reporter.id,
        targetType: 'ticket',
        metadata: {
          reasonCode: 'duplicate',
          by: 'reporter',
          fromStatus: 'new',
        },
      });
      const theirs = await open();
      await x.asManager(c, () =>
        confirmation.cancelByDispatcher(theirs.id, 'invalid'),
      );
      const row = await single(c, 'ticket.cancelled', theirs.id);
      expect(row).toMatchObject({
        actorId: c.managerId,
        metadata: {
          reasonCode: 'invalid',
          by: 'dispatcher',
          fromStatus: 'new',
        },
      });
      expect(JSON.stringify(row)).not.toContain('AUDIT-');
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
