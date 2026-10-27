import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { PLAN_SWEEP } from '../../src/maintenance/plans/plan-sweep';
import { auditReaders } from '../setup/audit';
import { day } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { ASSETS_COVERAGE } from '../setup/audit-coverage-split';
import { assetHelpers, type AssetSetUp } from '../setup/assets';
import type { Compound } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * One scenario per entry of the asset register's catalog (ADR 0014, 0064):
 * actor, target, changes and metadata, and never a name the compound
 * wrote, a note, a vendor's contact or a tag.
 */
const covered = new Set<string>();

describe('Audit coverage — assets, plans and inspections', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof assetHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: AssetSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = assetHelpers(h);
    read = auditReaders(h);
    s = await a.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  async function single(c: Compound, action: string, targetId: string) {
    const rows = await read.tenant(c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }

  describe('common areas', () => {
    it('common_area.created, .updated and .tag_issued — codes, never the names or the tag', async () => {
      const area = await a.area(s, {
        nameEn: 'AUDIT-secret pump room',
        building: s.building,
        latitude: 30,
        longitude: 31,
      });
      const created = await single(s.c, 'common_area.created', area.id);
      expect(created).toMatchObject({
        actorId: s.manager.id,
        changes: {
          kind: { from: null, to: 'area' },
          code: { from: null, to: area.code },
          building: { from: null, to: s.building },
          nameEn: { changed: true },
          hasPosition: { from: null, to: true },
        },
      });
      await a
        .http('patch', `/maintenance/areas/${area.id}`, s.manager.token, {
          nameEn: 'AUDIT-other',
          active: false,
        })
        .expect(200);
      const updated = await single(s.c, 'common_area.updated', area.id);
      expect(updated.changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });

      const other = await a.area(s);
      const tag = await a
        .http('post', `/maintenance/areas/${other.id}/tag`, s.manager.token)
        .expect(201);
      const issued = await single(s.c, 'common_area.tag_issued', other.id);
      expect(issued.metadata).toEqual({ replaced: false });
      const token = (tag.body as { code: string }).code.split('.')[2];
      for (const row of [created, updated, issued])
        expect(JSON.stringify(row)).not.toMatch(new RegExp(`AUDIT-|${token}`));
    });
  });

  describe('the register', () => {
    const types = async () =>
      (
        (
          await a
            .http('get', '/maintenance/asset-types', s.manager.token)
            .expect(200)
        ).body as { data: { id: string; key: string }[] }
      ).data;

    it('asset_type.created and .updated — keys and the category, never the names', async () => {
      const created = (
        await a
          .http('post', '/maintenance/asset-types', s.manager.token, {
            key: `audit_${Date.now()}`,
            nameAr: 'AUDIT-نوع',
            nameEn: 'AUDIT-type',
            categoryId: await a.categoryId(s.c, 'ac'),
            expectedLifeYears: 12,
          })
          .expect(201)
      ).body as { id: string; key: string };
      const one = await single(s.c, 'asset_type.created', created.id);
      expect(one.changes).toMatchObject({
        key: { from: null, to: created.key },
        categoryKey: { from: null, to: 'ac' },
        nameEn: { changed: true },
        expectedLifeYears: { from: null, to: 12 },
      });
      await a
        .http(
          'patch',
          `/maintenance/asset-types/${created.id}`,
          s.manager.token,
          {
            nameEn: 'AUDIT-other',
            active: false,
          },
        )
        .expect(200);
      const two = await single(s.c, 'asset_type.updated', created.id);
      expect(two.changes).toEqual({
        nameEn: { changed: true },
        active: { from: true, to: false },
      });
      for (const row of [one, two])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });

    it('asset.created, .updated, .status_changed, .moved, .tag_issued, .retired — codes and amounts; names, vendor and serial as changed', async () => {
      const pump = (await types()).find((t) => t.key === 'pump')!.id;
      const from = await a.area(s);
      const to = await a.area(s);
      const asset = (
        await a
          .http('post', '/maintenance/assets', s.manager.token, {
            code: `AU-${Date.now()}`,
            typeId: pump,
            commonAreaId: from.id,
            nameAr: 'AUDIT-مضخة',
            nameEn: 'AUDIT-pump',
            vendorName: 'AUDIT-vendor',
            vendorPhone: '+20 2 7777 1234',
            serialNumber: 'AUDIT-SN',
            purchaseValue: '1200.5',
            warrantyEndsOn: '2030-01-31',
          })
          .expect(201)
      ).body as { id: string; code: string };
      const created = await single(s.c, 'asset.created', asset.id);
      expect(created).toMatchObject({
        actorId: s.manager.id,
        changes: {
          code: { from: null, to: asset.code },
          commonAreaId: { from: null, to: from.id },
          purchaseValue: { from: null, to: '1200.50' },
          warrantyEndsOn: { from: null, to: '2030-01-31' },
          nameEn: { changed: true },
          vendorName: { changed: true },
          vendorPhone: { changed: true },
          serialNumber: { changed: true },
        },
      });
      await a
        .http('patch', `/maintenance/assets/${asset.id}`, s.manager.token, {
          condition: 'fair',
          vendorPhone: '+20 2 7777 9999',
        })
        .expect(200);
      const updated = await single(s.c, 'asset.updated', asset.id);
      expect(updated.changes).toEqual({
        condition: { from: 'good', to: 'fair' },
        vendorPhone: { changed: true },
      });
      await a
        .http(
          'post',
          `/maintenance/assets/${asset.id}/status`,
          s.manager.token,
          {
            status: 'out_of_service',
            reasonCode: 'awaiting_parts',
          },
        )
        .expect(201);
      const status = await single(s.c, 'asset.status_changed', asset.id);
      expect(status).toMatchObject({
        changes: { status: { from: 'in_service', to: 'out_of_service' } },
        metadata: { reasonCode: 'awaiting_parts' },
      });
      await a
        .http('post', `/maintenance/assets/${asset.id}/move`, s.manager.token, {
          commonAreaId: to.id,
        })
        .expect(201);
      const moved = await single(s.c, 'asset.moved', asset.id);
      expect(moved).toMatchObject({
        changes: { commonAreaId: { from: from.id, to: to.id } },
        metadata: { parts: 0 },
      });
      const tag = await a
        .http('post', `/maintenance/assets/${asset.id}/tag`, s.manager.token)
        .expect(201);
      const tagged = await single(s.c, 'asset.tag_issued', asset.id);
      expect(tagged.metadata).toEqual({ replaced: false });
      await a
        .http(
          'post',
          `/maintenance/assets/${asset.id}/retire`,
          s.manager.token,
          { reasonCode: 'sold' },
        )
        .expect(201);
      const retired = await single(s.c, 'asset.retired', asset.id);
      expect(retired.metadata).toEqual({ reasonCode: 'sold' });
      const token = (tag.body as { code: string }).code.split('.')[2];
      for (const row of [created, updated, status, moved, tagged, retired])
        expect(JSON.stringify(row)).not.toMatch(
          new RegExp(`AUDIT-|7777|${token}`),
        );
    });

    it('maintenance_document.added and .removed — the subject, kind and file; never the title', async () => {
      const room = await a.area(s);
      const fileId = await fileHelpers(h).ready(
        s.manager.token,
        'asset_document',
        'application/pdf',
      );
      const doc = (
        await a
          .http('post', '/maintenance/documents', s.manager.token, {
            commonAreaId: room.id,
            fileId,
            kind: 'plan',
            title: 'AUDIT-floor plan',
          })
          .expect(201)
      ).body as { id: string };
      const added = await single(s.c, 'maintenance_document.added', doc.id);
      expect(added).toMatchObject({
        changes: { title: { changed: true } },
        metadata: { commonAreaId: room.id, kind: 'plan', fileId },
      });
      await a
        .http(
          'post',
          `/maintenance/documents/${doc.id}/remove`,
          s.manager.token,
        )
        .expect(204);
      const removed = await single(s.c, 'maintenance_document.removed', doc.id);
      expect(removed.metadata).toEqual({ kind: 'plan' });
      for (const row of [added, removed])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });

    it('asset_import.checked and .applied — counts only, never a cell', async () => {
      const room = await a.area(s);
      const files = fileHelpers(h);
      const body = Buffer.from(
        `code,type,name_ar,name_en,area\nAI-${Date.now()},pump,AUDIT-مضخة,AUDIT-pump,${room.code}\n`,
      );
      const fileId = await files.uploaded(
        s.manager.token,
        'data_import',
        'text/csv',
        body,
      );
      await files.finalize(s.manager.token, fileId).expect(200);
      const checked = (
        await a
          .http('post', '/maintenance/asset-imports', s.manager.token, {
            fileId,
          })
          .expect(201)
      ).body as { id: string };
      const one = await single(s.c, 'asset_import.checked', checked.id);
      expect(one.metadata).toEqual({ fileId, rowCount: 1, errorCount: 0 });
      await a
        .http(
          'post',
          `/maintenance/asset-imports/${checked.id}/apply`,
          s.manager.token,
        )
        .expect(201);
      const two = await single(s.c, 'asset_import.applied', checked.id);
      expect(two.metadata).toEqual({ created: 1 });
      for (const row of [one, two])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });
  });

  describe('work orders', () => {
    it('ticket.work_order_opened, .work_accepted, .work_sent_back — origin, asset, codes; never the words', async () => {
      await a.specialize(s, s.techs[0], ['plumbing']);
      await a.setAvailability(s.c, s.techs[0].id, 'available');
      const pump = (
        (
          await a
            .http('get', '/maintenance/asset-types', s.manager.token)
            .expect(200)
        ).body as {
          data: { id: string; key: string }[];
        }
      ).data.find((t) => t.key === 'pump')!.id;
      const area = await a.area(s);
      const assetId = (
        (
          await a
            .http('post', '/maintenance/assets', s.manager.token, {
              code: `AW-${Date.now()}`,
              typeId: pump,
              commonAreaId: area.id,
              nameAr: 'مضخة',
              nameEn: 'Pump',
            })
            .expect(201)
        ).body as { id: string }
      ).id;
      const categoryId = await a.categoryId(s.c, 'plumbing');
      const ticket = await a.x.asManager(s.c, () =>
        h.moduleRef.get(TenantTx).withTenantTx((tx) =>
          h.moduleRef.get(TicketsService).createWorkOrder(tx, {
            tenantId: s.c.tenantId,
            origin: 'inspection',
            assetId,
            categoryId,
            priority: 'urgent',
            description: 'AUDIT-words of the finding',
            responsibleId: s.supervisor.id,
            actorId: s.supervisor.id,
          }),
        ),
      );
      const opened = await single(s.c, 'ticket.work_order_opened', ticket.id);
      expect(opened.metadata).toEqual({
        origin: 'inspection',
        assetId,
        commonAreaId: area.id,
        categoryKey: 'plumbing',
        priority: 'urgent',
      });
      const work = async () => {
        await a
          .http(
            'post',
            `/maintenance/tickets/${ticket.id}/assign`,
            s.supervisor.token,
            {
              technicianId: s.techs[0].id,
            },
          )
          .expect((r) => expect([200, 201, 204, 409]).toContain(r.status));
        await a
          .http(
            'post',
            `/technician/tickets/${ticket.id}/start`,
            s.techs[0].token,
          )
          .expect(204);
        await a
          .http(
            'post',
            `/technician/tickets/${ticket.id}/complete`,
            s.techs[0].token,
          )
          .expect(204);
      };
      await work();
      await a
        .http(
          'post',
          `/maintenance/tickets/${ticket.id}/send-back`,
          s.supervisor.token,
          {
            reasonCode: 'incomplete',
            reason: 'AUDIT-half done',
          },
        )
        .expect(204);
      const back = await single(s.c, 'ticket.work_sent_back', ticket.id);
      expect(back).toMatchObject({
        actorId: s.supervisor.id,
        metadata: { origin: 'inspection', reasonCode: 'incomplete', cycle: 1 },
      });
      await a
        .http(
          'post',
          `/technician/tickets/${ticket.id}/start`,
          s.techs[0].token,
        )
        .expect(204);
      await a
        .http(
          'post',
          `/technician/tickets/${ticket.id}/complete`,
          s.techs[0].token,
        )
        .expect(204);
      await a
        .http(
          'post',
          `/maintenance/tickets/${ticket.id}/accept-work`,
          s.supervisor.token,
        )
        .expect(204);
      const accepted = await single(s.c, 'ticket.work_accepted', ticket.id);
      expect(accepted.metadata).toEqual({ origin: 'inspection', cycle: 2 });
      for (const row of [opened, back, accepted])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });
  });

  describe('checklists', () => {
    it('checklist.created, .updated, .items_replaced — keys, purpose, version and counts; never names or labels', async () => {
      const cl = await a.checklist(
        s,
        [{ kind: 'check', labelAr: 'AUDIT-بند', labelEn: 'AUDIT-item' }],
        { nameEn: 'AUDIT-checklist', purpose: 'inspection' },
      );
      const created = await single(s.c, 'checklist.created', cl.id);
      expect(created).toMatchObject({
        changes: {
          purpose: { from: null, to: 'inspection' },
          nameEn: { changed: true },
        },
        metadata: { items: 1 },
      });
      await a
        .http('patch', `/maintenance/checklists/${cl.id}`, s.manager.token, {
          nameEn: 'AUDIT-renamed',
          requireScan: true,
        })
        .expect(200);
      const updated = await single(s.c, 'checklist.updated', cl.id);
      expect(updated.changes).toEqual({
        nameEn: { changed: true },
        requireScan: { from: false, to: true },
      });
      await a
        .http(
          'put',
          `/maintenance/checklists/${cl.id}/items`,
          s.manager.token,
          {
            items: [
              { kind: 'check', labelAr: 'AUDIT-أ', labelEn: 'AUDIT-a' },
              { kind: 'text', labelAr: 'AUDIT-ب', labelEn: 'AUDIT-b' },
            ],
          },
        )
        .expect(200);
      const replaced = await single(s.c, 'checklist.items_replaced', cl.id);
      expect(replaced).toMatchObject({
        changes: { version: { from: 1, to: 2 } },
        metadata: { items: 2 },
      });
      for (const row of [created, updated, replaced])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });
  });

  describe('plans', () => {
    it('maintenance_plan.* — codes, dates, reasons; never the title', async () => {
      const assetId = await a.asset(s);
      const created = (
        await a
          .http('post', '/maintenance/plans', s.manager.token, {
            assetId,
            title: 'AUDIT-service the pump',
            trigger: 'calendar',
            every: 1,
            unit: 'month',
            anchorOn: day(40),
          })
          .expect(201)
      ).body as { id: string; nextDueOn: string };
      const one = await single(s.c, 'maintenance_plan.created', created.id);
      expect(one.changes).toMatchObject({
        assetId: { from: null, to: assetId },
        trigger: { from: null, to: 'calendar' },
        anchorOn: { from: null, to: day(40) },
        title: { changed: true },
      });
      await a
        .http('patch', `/maintenance/plans/${created.id}`, s.manager.token, {
          title: 'AUDIT-renamed',
          leadDays: 3,
        })
        .expect(200);
      const updated = await single(s.c, 'maintenance_plan.updated', created.id);
      expect(updated.changes).toEqual({
        title: { changed: true },
        leadDays: { from: 7, to: 3 },
      });
      await a
        .http(
          'post',
          `/maintenance/plans/${created.id}/defer`,
          s.manager.token,
          {
            toDate: day(45),
            reasonCode: 'vendor_delay',
          },
        )
        .expect(201);
      const deferred = await single(
        s.c,
        'maintenance_plan.deferred',
        created.id,
      );
      expect(deferred).toMatchObject({
        changes: { nextDueOn: { from: day(40), to: day(45) } },
        metadata: { reasonCode: 'vendor_delay' },
      });
      await a
        .http(
          'post',
          `/maintenance/plans/${created.id}/skip`,
          s.manager.token,
          { reasonCode: 'covered_by_other_work' },
        )
        .expect(201);
      const skipped = await single(s.c, 'maintenance_plan.skipped', created.id);
      expect(skipped.metadata).toEqual({
        reasonCode: 'covered_by_other_work',
        dueOn: day(45),
      });
      await a
        .http(
          'post',
          `/maintenance/plans/${created.id}/deactivate`,
          s.manager.token,
          { reasonCode: 'contract_ended' },
        )
        .expect(201);
      const off = await single(s.c, 'maintenance_plan.deactivated', created.id);
      expect(off.metadata).toEqual({ reasonCode: 'contract_ended' });
      await a
        .http(
          'post',
          `/maintenance/plans/${created.id}/reactivate`,
          s.manager.token,
        )
        .expect(201);
      const on = await single(s.c, 'maintenance_plan.reactivated', created.id);

      const now = (
        await a
          .http('post', '/maintenance/plans', s.manager.token, {
            assetId,
            title: 'AUDIT-now',
            trigger: 'calendar',
            every: 1,
            unit: 'week',
            anchorOn: day(0),
            leadDays: 0,
          })
          .expect(201)
      ).body as { id: string };
      await h.moduleRef.get(SweepRunner).run(PLAN_SWEEP, new Date());
      const occurrence = await a.inTenant(s.c, (tx) =>
        tx.maintenancePlanOccurrence.findFirstOrThrow({
          where: { planId: now.id },
        }),
      );
      await a
        .http(
          'post',
          `/maintenance/plan-occurrences/${occurrence.id}/defer`,
          s.manager.token,
          {
            toDate: day(3),
            reasonCode: 'access_unavailable',
          },
        )
        .expect(201);
      const moved = await single(
        s.c,
        'maintenance_plan.occurrence_deferred',
        now.id,
      );
      expect(moved).toMatchObject({
        changes: { dueOn: { from: day(0), to: day(3) } },
        metadata: {
          occurrenceId: occurrence.id,
          reasonCode: 'access_unavailable',
        },
      });
      for (const row of [one, updated, deferred, skipped, off, on, moved])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });
  });

  describe('inspections', () => {
    it('inspection_round.* and inspection.* — codes, days, reasons, the attestation; never the title', async () => {
      const area = await a.area(s);
      const cl = await a.checklist(s, undefined, { purpose: 'inspection' });
      const round = (
        await a
          .http('post', '/maintenance/inspection-rounds', s.manager.token, {
            title: 'AUDIT-round',
            checklistId: cl.id,
            commonAreaId: area.id,
            assigneeId: s.techs[0].id,
            every: 2,
            unit: 'week',
            anchorOn: day(20),
          })
          .expect(201)
      ).body as { id: string };
      const created = await single(s.c, 'inspection_round.created', round.id);
      expect(created.changes).toMatchObject({
        title: { changed: true },
        commonAreaId: { from: null, to: area.id },
        assigneeId: { from: null, to: s.techs[0].id },
        every: { from: null, to: 2 },
      });
      await a
        .http(
          'patch',
          `/maintenance/inspection-rounds/${round.id}`,
          s.manager.token,
          { title: 'AUDIT-renamed', leadDays: 4 },
        )
        .expect(200);
      const updated = await single(s.c, 'inspection_round.updated', round.id);
      expect(updated.changes).toEqual({
        title: { changed: true },
        leadDays: { from: 2, to: 4 },
      });
      await a
        .http(
          'post',
          `/maintenance/inspection-rounds/${round.id}/deactivate`,
          s.manager.token,
        )
        .expect(201);
      const off = await single(s.c, 'inspection_round.deactivated', round.id);
      await a
        .http(
          'post',
          `/maintenance/inspection-rounds/${round.id}/reactivate`,
          s.manager.token,
        )
        .expect(201);
      const on = await single(s.c, 'inspection_round.reactivated', round.id);

      const one = (
        await a
          .http('post', '/maintenance/inspections', s.manager.token, {
            checklistId: cl.id,
            commonAreaId: area.id,
            assigneeId: s.techs[0].id,
            dueOn: day(2),
          })
          .expect(201)
      ).body as { id: string; checklist: { items: { id: string }[] } };
      const scheduled = await single(s.c, 'inspection.created', one.id);
      expect(scheduled.metadata).toEqual({
        checklistId: cl.id,
        assetId: null,
        commonAreaId: area.id,
        assigneeId: s.techs[0].id,
        dueOn: day(2),
      });
      await a
        .http(
          'post',
          `/technician/inspections/${one.id}/start`,
          s.techs[0].token,
          {},
        )
        .expect(201);
      await a
        .http(
          'put',
          `/technician/inspections/${one.id}/items/${one.checklist.items[0].id}`,
          s.techs[0].token,
          {
            result: 'pass',
            note: 'AUDIT-note',
          },
        )
        .expect(200);
      const submitted = (
        await a
          .http(
            'post',
            `/technician/inspections/${one.id}/submit`,
            s.techs[0].token,
          )
          .expect(201)
      ).body as { checklist: { attestationSha256: string } };
      const done = await single(s.c, 'inspection.submitted', one.id);
      expect(done.metadata).toEqual({
        findings: 0,
        attestationSha256: submitted.checklist.attestationSha256,
      });
      const two = (
        await a
          .http('post', '/maintenance/inspections', s.manager.token, {
            checklistId: cl.id,
            commonAreaId: area.id,
            assigneeId: s.techs[0].id,
            dueOn: day(3),
          })
          .expect(201)
      ).body as { id: string };
      await a
        .http(
          'post',
          `/maintenance/inspections/${two.id}/cancel`,
          s.manager.token,
          { reasonCode: 'duplicate' },
        )
        .expect(201);
      const cancelled = await single(s.c, 'inspection.cancelled', two.id);
      expect(cancelled.metadata).toEqual({
        reasonCode: 'duplicate',
        fromStatus: 'scheduled',
      });
      for (const row of [created, updated, off, on, scheduled, done, cancelled])
        expect(JSON.stringify(row)).not.toMatch(/AUDIT-/);
    });
  });

  describe('catalog completeness', () => {
    it('every asset entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of ASSETS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...ASSETS_COVERAGE].sort());
    });
  });
});
