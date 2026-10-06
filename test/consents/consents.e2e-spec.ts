import { CONSENT_CATALOG } from '../../src/core/consents/consent-catalog';
import { ConsentsService } from '../../src/core/consents/consents.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { DispatchService } from '../../src/maintenance/tickets/dispatch.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { WorkService } from '../../src/maintenance/tickets/work.service';
import { communityHelpers, type Compound } from '../setup/community';
import { eraseNow } from '../setup/erasure';
import { gateHelpers } from '../setup/gate';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * Consents (ADR 0036): versions, revocation at any time, the history and
 * its projection — and the first use: the technician assigned now to an
 * open ticket sees the reporter's phone only while the reporter allows it
 * and still has the ticket's unit. Nobody else ever does.
 */
describe('Consents', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let consents: ConsentsService;
  let c: Compound;
  let categoryId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    consents = h.moduleRef.get(ConsentsService);
    c = await x.compound('Consent Court');
    categoryId = (
      await x.asManager(c, () =>
        x.prisma.tenant.ticketCategory.findFirstOrThrow({
          where: { key: 'plumbing' },
        }),
      )
    ).id;
  });

  afterAll(() => h.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const tokenOf = (id: string, typ: 'resident' | 'staff' | 'manager') =>
    h.tokenFor({ sub: id, tid: c.tenantId, typ });

  async function reporter() {
    const unit = await x.unit(c);
    const p = await x.resident(c, [unit.id]);
    return { ...p, unitId: unit.id, token: await tokenOf(p.id, 'resident') };
  }

  const grant = (token: string, version = 1) =>
    h
      .http()
      .post(`${API}/me/consents/grant`)
      .set(bearer(token))
      .send({ code: 'ticket_phone_share', version });
  const revoke = (token: string) =>
    h
      .http()
      .post(`${API}/me/consents/revoke`)
      .set(bearer(token))
      .send({ code: 'ticket_phone_share' });

  /** A ticket the reporter opened, assigned to a technician. */
  async function assignedTicket(r: { id: string; unitId: string }) {
    const tech = await gateHelpers(h).guard(c, 'technician');
    const ticket = await x.as(c, { id: r.id, type: 'resident' }, () =>
      h.moduleRef.get(TicketsService).create({
        unitId: r.unitId,
        categoryId,
        description: 'Leak under the sink',
      }),
    );
    await x.asManager(c, () =>
      h.moduleRef.get(DispatchService).assign(ticket.id, tech.id),
    );
    return {
      ticketId: ticket.id,
      tech,
      techToken: await tokenOf(tech.id, 'staff'),
    };
  }

  const techView = async (token: string, ticketId: string) =>
    h.http().get(`${API}/technician/tickets/${ticketId}`).set(bearer(token));
  const phoneSeen = async (token: string, ticketId: string) => {
    const res = await techView(token, ticketId);
    expect(res.status).toBe(200);
    return (res.body as { reporterPhone: string | null }).reporterPhone;
  };

  // --------------------------------------------------------------------------
  it('starts off, is granted at the current version, revoked any time', async () => {
    const r = await reporter();
    const list = await h
      .http()
      .get(`${API}/me/consents`)
      .set(bearer(r.token))
      .expect(200);
    expect(list.body).toEqual({
      data: [
        {
          code: 'ticket_phone_share',
          version: 1,
          granted: false,
          grantedAt: null,
        },
      ],
      nextCursor: null,
    });

    const wrong = await grant(r.token, 2).expect(409);
    expect(wrong.body).toMatchObject({
      code: 'CONSENT_VERSION_MISMATCH',
      params: { current: 1 },
    });

    const granted = await grant(r.token).expect(200);
    expect(granted.body).toMatchObject({
      code: 'ticket_phone_share',
      granted: true,
    });
    await grant(r.token).expect(200); // nothing new
    const revoked = await revoke(r.token).expect(200);
    expect(revoked.body).toMatchObject({ granted: false, grantedAt: null });
    await revoke(r.token).expect(200); // nothing new

    const events = await x.asManager(c, () =>
      x.prisma.tenant.consentEvent.findMany({
        where: { accountId: r.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(
      events.map((e) => [
        e.action,
        e.version,
        e.actorType,
        e.actorAccountId,
        e.assisted,
      ]),
    ).toEqual([
      ['grant', 1, 'account', r.id, false],
      ['revoke', 1, 'account', r.id, false],
    ]);
  });

  it('the projection is what the history rebuilds', async () => {
    const r = await reporter();
    await grant(r.token).expect(200);
    await revoke(r.token).expect(200);
    await grant(r.token).expect(200);
    await x.as(c, { id: r.id, type: 'resident' }, () =>
      h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
        const rebuilt = await consents.rebuild(tx, r.id);
        const stored = await tx.accountConsent.findMany({
          where: { accountId: r.id },
        });
        expect(stored).toHaveLength(rebuilt.size);
        for (const s of stored)
          expect(rebuilt.get(s.code)).toEqual({
            grantedVersion: s.grantedVersion,
            grantedAt: s.grantedAt,
            lastEventId: s.lastEventId,
          });
      }),
    );
  });

  it('a new version makes an earlier grant stop counting until granted again', async () => {
    const r = await reporter();
    const t = await assignedTicket(r);
    await grant(r.token).expect(200);
    expect(await phoneSeen(t.techToken, t.ticketId)).toBe(r.phone);

    const bump = jest.replaceProperty(
      CONSENT_CATALOG.ticket_phone_share,
      'version',
      2,
    );
    try {
      const list = await h
        .http()
        .get(`${API}/me/consents`)
        .set(bearer(r.token))
        .expect(200);
      expect((list.body as { data: unknown[] }).data[0]).toMatchObject({
        version: 2,
        granted: false,
      });
      expect(await phoneSeen(t.techToken, t.ticketId)).toBeNull();
      await grant(r.token, 1).expect(409);
      await grant(r.token, 2).expect(200);
      expect(await phoneSeen(t.techToken, t.ticketId)).toBe(r.phone);
    } finally {
      bump.restore();
    }
  });

  // --------------------------------------------------------------------------
  describe("the reporter's phone", () => {
    it('is shown to the assigned technician of an open ticket, only while consented', async () => {
      const r = await reporter();
      const t = await assignedTicket(r);
      expect(await phoneSeen(t.techToken, t.ticketId)).toBeNull();
      await grant(r.token).expect(200);
      expect(await phoneSeen(t.techToken, t.ticketId)).toBe(r.phone);

      // In progress and on hold: still open.
      const work = h.moduleRef.get(WorkService);
      await x.as(c, { id: t.tech.id, type: 'staff' }, () =>
        work.start(t.ticketId),
      );
      expect(await phoneSeen(t.techToken, t.ticketId)).toBe(r.phone);

      // Revoked: hidden on the very next read.
      await revoke(r.token).expect(200);
      expect(await phoneSeen(t.techToken, t.ticketId)).toBeNull();
    });

    it('is never shown to another technician, to dispatch or to residents', async () => {
      const r = await reporter();
      const t = await assignedTicket(r);
      await grant(r.token).expect(200);
      const other = await gateHelpers(h).guard(c, 'technician');
      const otherToken = await tokenOf(other.id, 'staff');
      const notTheirs = await techView(otherToken, t.ticketId);
      expect(notTheirs.status).toBe(404);
      expect(notTheirs.text).not.toContain(r.phone);
      const managerToken = await tokenOf(c.managerId, 'manager');
      for (const path of [
        `/maintenance/tickets/${t.ticketId}`,
        `/maintenance/tickets/${t.ticketId}/messages`,
        `/maintenance/tickets/${t.ticketId}/history`,
        `/maintenance/tickets`,
      ]) {
        const res = await h
          .http()
          .get(`${API}${path}`)
          .set(bearer(managerToken));
        expect([path, res.status]).toEqual([path, 200]);
        expect([path, res.text.includes(r.phone)]).toEqual([path, false]);
      }
      const own = await h
        .http()
        .get(`${API}/tickets/${t.ticketId}`)
        .set(bearer(r.token));
      expect(own.status).toBe(200);
      expect(own.text).not.toContain(r.phone);
      const list = await h
        .http()
        .get(`${API}/technician/tickets`)
        .set(bearer(t.techToken));
      expect(list.text).not.toContain(r.phone);
    });

    it('is hidden once the work is completed', async () => {
      const r = await reporter();
      const t = await assignedTicket(r);
      await grant(r.token).expect(200);
      const work = h.moduleRef.get(WorkService);
      await x.as(c, { id: t.tech.id, type: 'staff' }, () =>
        work.start(t.ticketId),
      );
      await x.as(c, { id: t.tech.id, type: 'staff' }, () =>
        work.complete(t.ticketId),
      );
      expect(await phoneSeen(t.techToken, t.ticketId)).toBeNull();
    });

    it('is hidden once the reporter no longer has the unit', async () => {
      const unit = await x.unit(c);
      await x.resident(c, [unit.id]);
      const tenant = await x.resident(c, [unit.id], 'tenant');
      const r = {
        ...tenant,
        unitId: unit.id,
        token: await tokenOf(tenant.id, 'resident'),
      };
      const t = await assignedTicket(r);
      await grant(r.token).expect(200);
      expect(await phoneSeen(t.techToken, t.ticketId)).toBe(r.phone);
      const occupancy = (await x.occupancies(c, unit.id)).find(
        (o) => o.accountId === r.id && o.status === 'active',
      )!;
      await x.asManager(c, () =>
        x.residents.endOccupancy(occupancy.id, {
          code: 'moved_out',
          text: 'Left',
        }),
      );
      expect(await phoneSeen(t.techToken, t.ticketId)).toBeNull();
    });

    it('is never shown for a deactivated, frozen or erased reporter', async () => {
      const accounts = h.moduleRef.get(AccountsService);
      const cases: ((id: string) => Promise<unknown>)[] = [
        (id) =>
          x.asManager(c, () =>
            accounts.updateStatus(id, { status: 'inactive' }),
          ),
        (id) =>
          x.asManager(c, () =>
            accounts.freeze(id, {
              code: 'phone_reassigned',
              text: 'New owner',
            }),
          ),
        (id) => eraseNow(h, c, id),
      ];
      for (const end of cases) {
        // Not a primary: erasure is refused for one (ADR 0036).
        const unit = await x.unit(c);
        await x.resident(c, [unit.id]);
        const tenant = await x.resident(c, [unit.id], 'tenant');
        const r = {
          ...tenant,
          unitId: unit.id,
          token: await tokenOf(tenant.id, 'resident'),
        };
        const t = await assignedTicket(r);
        await grant(r.token).expect(200);
        expect(await phoneSeen(t.techToken, t.ticketId)).toBe(r.phone);
        await end(r.id);
        const res = await techView(t.techToken, t.ticketId);
        expect(res.status).toBe(200);
        expect(
          (res.body as { reporterPhone: unknown }).reporterPhone,
        ).toBeNull();
        expect(res.text).not.toContain(r.phone);
      }
    });
  });

  it('an erasure revokes what was granted, through the history', async () => {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const tenant = await x.resident(c, [unit.id], 'tenant');
    await grant(await tokenOf(tenant.id, 'resident')).expect(200);
    await eraseNow(h, c, tenant.id);
    const events = await x.asManager(c, () =>
      x.prisma.tenant.consentEvent.findMany({
        where: { accountId: tenant.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(events.map((e) => [e.action, e.actorType])).toEqual([
      ['grant', 'account'],
      ['revoke', 'system'],
    ]);
    const row = await x.asManager(c, () =>
      x.prisma.tenant.accountConsent.findFirstOrThrow({
        where: { accountId: tenant.id },
      }),
    );
    expect(row.grantedVersion).toBeNull();
  });
});
