import { IdentityChangesService } from '../../src/core/accounts/identity-changes.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { R11A_COVERAGE } from '../setup/audit-coverage-split';
import { communityHelpers, type Compound } from '../setup/community';
import { stepUp } from '../setup/exports';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { fileHelpers } from '../setup/files';
import { sessionOf } from '../api/world';
import { leakText } from '../setup/leak-text';
import { loginViaOtp } from '../setup/login';

/**
 * One scenario per R11a entry (ADR 0014, 0062): actor, target, changes and
 * metadata — ids, codes and fields; a name, a phone or an email never.
 */
const covered = new Set<string>();

describe('Audit coverage — R11a', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('R11a Audit Court');
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  /** Exactly one entry for (action, target), free of the planted values. */
  async function single(action: string, targetId: string, planted: string[]) {
    const found = await read.tenant(c.tenantId, { action, targetId });
    covered.add(action);
    expect(found).toHaveLength(1);
    for (const value of planted)
      expect(leakText(found[0])).not.toContain(value);
    return found[0];
  }

  async function someone() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    const { accessToken } = await loginViaOtp(h, p.email, p.id);
    return { ...p, token: accessToken };
  }

  const post = (path: string, token: string, body: object = {}) =>
    h
      .http()
      .post(`${API}${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  describe('account self-service', () => {
    it('an email change asked; name and phone changes asked, withdrawn, decided', async () => {
      const me = await someone();
      const newEmail = uniqueEmail('audited');
      await stepUp(h, me.token, me.email);
      await post('/me/contact/email', me.token, { email: newEmail }).expect(
        202,
      );
      expect(
        await single('account.contact_change_requested', me.id, [newEmail]),
      ).toMatchObject({
        actorId: me.id,
        targetType: 'account',
        metadata: { field: 'email' },
      });

      const changes = h.moduleRef.get(IdentityChangesService);
      const asMe = <T>(fn: () => Promise<T>) =>
        x.as(c, { id: me.id, type: 'resident' }, fn);
      const name = 'Audited Newname';
      await stepUp(h, me.token, me.email);
      const asked = (
        await post('/me/identity-changes', me.token, {
          field: 'name',
          value: name,
        }).expect(201)
      ).body as { id: string };
      expect(
        await single('account.identity_change_requested', me.id, [name]),
      ).toMatchObject({
        actorId: me.id,
        metadata: { requestId: asked.id, field: 'name' },
      });
      await asMe(() => changes.cancel(asked.id));
      expect(
        await single('account.identity_change_cancelled', me.id, [name]),
      ).toMatchObject({ metadata: { requestId: asked.id, field: 'name' } });

      await stepUp(h, me.token, me.email);
      const again = (
        await post('/me/identity-changes', me.token, {
          field: 'name',
          value: name,
        }).expect(201)
      ).body as { id: string };
      await x.asManager(c, () => changes.approve(again.id));
      expect(
        await single('account.identity_change_approved', me.id, [name]),
      ).toMatchObject({
        actorId: c.managerId,
        metadata: { requestId: again.id, field: 'name' },
      });
      expect(
        await single('account.name_changed', me.id, [name, me.fullName]),
      ).toMatchObject({
        actorId: c.managerId,
        changes: { fullName: { changed: true } },
        metadata: { requestId: again.id },
      });

      const phone = uniquePhone();
      await stepUp(h, me.token, me.email);
      const byPhone = (
        await post('/me/identity-changes', me.token, {
          field: 'phone',
          value: phone,
        }).expect(201)
      ).body as { id: string };
      await x.asManager(c, () =>
        changes.reject(byPhone.id, { reasonCode: 'not_verified' }),
      );
      expect(
        await single('account.identity_change_rejected', me.id, [phone]),
      ).toMatchObject({
        actorId: c.managerId,
        metadata: {
          requestId: byPhone.id,
          field: 'phone',
          reasonCode: 'not_verified',
        },
      });
    });
  });

  describe('a unit vault', () => {
    it('added and deleted: ids, kind, visibility and side; never the title', async () => {
      const me = await someone();
      const unitId = (
        await x.asManager(c, () =>
          x.prisma.tenant.unitOccupancy.findFirstOrThrow({
            where: { accountId: me.id, status: 'active' },
          }),
        )
      ).unitId;
      const fileId = await fileHelpers(h).ready(
        me.token,
        'unit_document',
        'application/pdf',
      );
      const title = 'Audited boiler manual';
      const added = (
        await post(`/units/${unitId}/documents`, me.token, {
          fileId,
          kind: 'manual',
          title,
          visibility: 'occupants',
        }).expect(201)
      ).body as { id: string };
      expect(
        await single('unit_document.added', added.id, [title]),
      ).toMatchObject({
        actorId: me.id,
        targetType: 'unit_document',
        metadata: {
          unitId,
          kind: 'manual',
          visibility: 'occupants',
          side: 'resident',
        },
      });
      await post(
        `/units/${unitId}/documents/${added.id}/delete`,
        me.token,
      ).expect(204);
      expect(
        await single('unit_document.deleted', added.id, [title]),
      ).toMatchObject({
        actorId: me.id,
        metadata: { unitId, kind: 'manual', reasonCode: 'owner' },
      });
    });
  });

  describe('the compound’s documents', () => {
    it('a version published: kind, number, file and how many were told; never its text', async () => {
      const manager = await h.tokenFor({
        sub: c.managerId,
        tid: c.tenantId,
        typ: 'manager',
      });
      const bodyEn = 'Audited conduct guide text';
      const res = await post('/staff/compound-documents/versions', manager, {
        kind: 'conduct_guide',
        titleEn: 'Conduct',
        titleAr: 'السلوك',
        bodyEn,
        bodyAr: 'نص',
        effectiveOn: '2026-01-01',
      }).expect(201);
      const version = await x.asManager(c, () =>
        x.prisma.tenant.compoundDocumentVersion.findFirstOrThrow({
          where: {
            kind: 'conduct_guide',
            versionNo: (res.body as { versionNo: number }).versionNo,
          },
        }),
      );
      expect(
        await single('compound_document.published', version.id, [bodyEn]),
      ).toMatchObject({
        actorId: c.managerId,
        targetType: 'compound_document',
        metadata: {
          kind: 'conduct_guide',
          versionNo: 1,
          hasFile: false,
          told: 0,
        },
      });
    });
  });

  describe('contracts', () => {
    it('recorded, renewed, declined, withdrawn, voided: ids and codes', async () => {
      const manager = await h.tokenFor({
        sub: c.managerId,
        tid: c.tenantId,
        typ: 'manager',
      });
      const unit = await x.unit(c);
      await x.resident(c, [unit.id]);
      const t = await x.resident(c, [unit.id], 'tenant');
      const { accessToken: tenantToken } = await loginViaOtp(h, t.email, t.id);
      const tenantOcc = (
        await x.asManager(c, () =>
          x.prisma.tenant.unitOccupancy.findFirstOrThrow({
            where: { unitId: unit.id, accountId: t.id, status: 'active' },
          }),
        )
      ).id;
      const lease = async (body: object = {}) => {
        const fileId = await fileHelpers(h).ready(
          manager,
          'contract',
          'application/pdf',
        );
        return (
          (
            await post(`/staff/units/${unit.id}/contracts`, manager, {
              kind: 'lease',
              partyOccupancyIds: [tenantOcc],
              signedOn: '2026-01-01',
              startsOn: '2026-01-01',
              endsOn: '2099-12-31',
              noticeDays: 60,
              fileId,
              ...body,
            }).expect(201)
          ).body as { id: string }
        ).id;
      };
      const first = await lease();
      expect(await single('contract.recorded', first, [])).toMatchObject({
        actorId: c.managerId,
        targetType: 'contract',
        metadata: { unitId: unit.id, kind: 'lease', parties: 1 },
      });
      const ask = async (contractId: string) =>
        (
          (
            await post(
              `/units/${unit.id}/contracts/${contractId}/renewal-requests`,
              tenantToken,
            ).expect(201)
          ).body as { id: string }
        ).id;
      const withdrawn = await ask(first);
      await post(
        `/contract-renewals/${withdrawn}/withdraw`,
        tenantToken,
      ).expect(200);
      expect(
        await single('contract_renewal.withdrawn', withdrawn, []),
      ).toMatchObject({ actorId: t.id, metadata: { contractId: first } });
      const declined = await ask(first);
      expect(
        await single('contract_renewal.requested', declined, []),
      ).toMatchObject({ actorId: t.id, metadata: { contractId: first } });
      await post(`/staff/contract-renewals/${declined}/decline`, manager, {
        reasonCode: 'terms_not_agreed',
      }).expect(200);
      expect(
        await single('contract_renewal.declined', declined, []),
      ).toMatchObject({
        metadata: { contractId: first, reasonCode: 'terms_not_agreed' },
      });
      const renewed = await ask(first);
      const second = await lease({
        renewsId: first,
        renewalRequestId: renewed,
        startsOn: '2100-01-01',
        endsOn: '2100-12-31',
      });
      expect(
        await single('contract_renewal.renewed', renewed, []),
      ).toMatchObject({
        metadata: { contractId: first, renewedContractId: second },
      });
      await post(`/staff/contracts/${second}/void`, manager, {
        reasonCode: 'data_error',
      }).expect(200);
      expect(await single('contract.voided', second, [])).toMatchObject({
        actorId: c.managerId,
        metadata: { unitId: unit.id, reasonCode: 'data_error' },
      });
    });
  });

  describe('clearances and deposits', () => {
    it('issued, recorded, refund asked and withdrawn, settled: ids, codes, amounts', async () => {
      const manager = await h.tokenFor({
        sub: c.managerId,
        tid: c.tenantId,
        typ: 'manager',
      });
      const me = await someone();
      const occupancy = await x.asManager(c, () =>
        x.prisma.tenant.unitOccupancy.findFirstOrThrow({
          where: { accountId: me.id, status: 'active' },
        }),
      );
      const cleared = (
        await post(`/units/${occupancy.unitId}/clearances`, me.token).expect(
          201,
        )
      ).body as { id: string; number: string };
      expect(await single('clearance.issued', cleared.id, [])).toMatchObject({
        actorId: me.id,
        targetType: 'clearance',
        metadata: {
          unitId: occupancy.unitId,
          number: cleared.number,
          side: 'resident',
        },
      });
      const deposit = (
        await post('/staff/deposits', manager, {
          occupancyId: occupancy.id,
          kind: 'move',
          amount: '1000',
          receivedOn: '2026-01-01',
          method: 'cash',
        }).expect(201)
      ).body as { id: string };
      expect(await single('deposit.recorded', deposit.id, [])).toMatchObject({
        actorId: c.managerId,
        metadata: { unitId: occupancy.unitId, kind: 'move', amount: '1000.00' },
      });
      await post(`/deposits/${deposit.id}/refund-request`, me.token).expect(
        200,
      );
      expect(
        await single('deposit.refund_requested', deposit.id, []),
      ).toMatchObject({ actorId: me.id });
      await post(
        `/deposits/${deposit.id}/refund-request/withdraw`,
        me.token,
      ).expect(200);
      expect(
        await single('deposit.refund_withdrawn', deposit.id, []),
      ).toMatchObject({ actorId: me.id });
      await h.moduleRef.get(GlobalDbService).session.update({
        where: { id: sessionOf(manager) },
        data: { stepUpUntil: new Date(Date.now() + 600_000) },
      });
      await post(`/staff/deposits/${deposit.id}/settle`, manager, {
        refund: { amount: '900', channel: 'cash' },
        deductions: [{ reasonCode: 'cleaning', amount: '100' }],
      }).expect(200);
      expect(await single('deposit.settled', deposit.id, [])).toMatchObject({
        actorId: c.managerId,
        metadata: {
          parts: [
            { kind: 'refunded', amount: '900.00' },
            { kind: 'deducted', amount: '100.00', reasonCode: 'cleaning' },
          ],
        },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every R11a entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of R11A_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...R11A_COVERAGE].sort());
    });
  });
});
