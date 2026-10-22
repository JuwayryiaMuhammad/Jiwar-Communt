import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import {
  PARTNER_EXPIRE_SWEEP,
  PARTNER_LAPSE_SWEEP,
} from '../../src/partners/requests/request-sweeps';
import { PARTNERS_COVERAGE } from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  asSuperuser,
  partnersHelpers,
  shiftWindow,
  type PartnersSetUp,
  type Who,
} from '../setup/partners';

/**
 * One scenario per partners catalog entry (ADR 0014, 0060): actor, target,
 * changes and metadata — ids, codes, counts and windows by value; never a
 * partner's names, description, phone or email, a resident's name or what
 * anyone wrote.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — partners', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) {
      const text = JSON.stringify(row);
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('+2022555');
    }
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  describe('the catalogue', () => {
    let partnerId: string;
    let cleaning: string;

    beforeAll(async () => {
      cleaning = await p.subcategory(s.c, 'cleaning');
      const res = await p
        .http('post', '/staff/partners', s.keeper.token, {
          nameEn: `${MARKER} cleaners`,
          nameAr: `${MARKER} منظفون`,
          descriptionEn: `${MARKER} since 1999`,
          businessPhone: '+20225550199',
          notifyEmail: 'audit-free-text@example.com',
          serviceBuildings: ['A'],
          services: [{ category: 'home_services', subcategoryId: cleaning }],
        })
        .expect(201);
      partnerId = (res.body as { id: string }).id;
    });

    it('partner.created — standing, area and services by value; names, description, phone and email only as changed', async () => {
      const row = await single('partner.created', partnerId);
      expect(row).toMatchObject(by(s.keeper, 'partner'));
      expect(row.changes).toMatchObject({
        status: { from: null, to: 'active' },
        homeVisit: { from: null, to: false },
        serviceBuildings: { from: null, to: ['A'] },
        services: { from: null, to: [`home_services:${cleaning}`] },
        nameEn: { changed: true },
        nameAr: { changed: true },
        descriptionEn: { changed: true },
        businessPhone: { changed: true },
        notifyEmail: { changed: true },
      });
    });

    it('partner.updated — what changed, the names only as changed; nothing when nothing changed', async () => {
      await p
        .http('patch', `/staff/partners/${partnerId}`, s.keeper.token, {
          nameEn: `${MARKER} cleaners 2`,
          homeVisit: true,
        })
        .expect(200);
      await p
        .http('patch', `/staff/partners/${partnerId}`, s.keeper.token, {
          homeVisit: true,
        })
        .expect(200);
      const row = await single('partner.updated', partnerId);
      expect(row).toMatchObject(by(s.keeper, 'partner'));
      expect(row.changes).toEqual({
        nameEn: { changed: true },
        homeVisit: { from: false, to: true },
      });
    });

    it('partner.services_changed — the services as codes', async () => {
      await p
        .http('put', `/staff/partners/${partnerId}/services`, s.keeper.token, {
          services: [
            { category: 'home_services', subcategoryId: cleaning },
            { category: 'pets' },
          ],
        })
        .expect(200);
      const row = await single('partner.services_changed', partnerId);
      expect(row).toMatchObject(by(s.keeper, 'partner'));
      expect(row.changes).toEqual({
        services: {
          from: [`home_services:${cleaning}`],
          to: [`home_services:${cleaning}`, 'pets'],
        },
      });
    });

    it('partner.hours_changed — the windows as codes', async () => {
      await p
        .http('put', `/staff/partners/${partnerId}/hours`, s.keeper.token, {
          windows: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
        })
        .expect(200);
      const row = await single('partner.hours_changed', partnerId);
      expect(row.changes).toEqual({
        windows: { from: [], to: ['1:540-1020'] },
      });
    });

    it('partner.prices_changed — the lines as unit and price, never their names', async () => {
      await p
        .http('put', `/staff/partners/${partnerId}/prices`, s.keeper.token, {
          items: [
            {
              nameEn: `${MARKER} visit`,
              nameAr: `${MARKER} زيارة`,
              price: '150.5',
              unit: 'visit_fee',
              subcategoryId: cleaning,
            },
          ],
        })
        .expect(200);
      const row = await single('partner.prices_changed', partnerId);
      expect(row.changes).toEqual({
        items: { from: [], to: ['visit_fee:150.50'] },
      });
    });

    it('partner_subcategory.created and .updated — key and category by value, names as changed', async () => {
      const res = await p
        .http('post', '/staff/partner-subcategories', s.keeper.token, {
          category: 'home_services',
          key: 'windows',
          nameEn: `${MARKER} windows`,
          nameAr: `${MARKER} نوافذ`,
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      const created = await single('partner_subcategory.created', id);
      expect(created).toMatchObject(by(s.keeper, 'partner_subcategory'));
      expect(created.changes).toMatchObject({
        category: { from: null, to: 'home_services' },
        key: { from: null, to: 'windows' },
        nameEn: { changed: true },
      });
      await p
        .http('patch', `/staff/partner-subcategories/${id}`, s.keeper.token, {
          nameAr: `${MARKER} نوافذ ٢`,
          active: false,
        })
        .expect(200);
      const updated = await single('partner_subcategory.updated', id);
      expect(updated.changes).toEqual({
        nameAr: { changed: true },
        active: { from: true, to: false },
      });
    });

    it('partner.settings_changed — the settings by value', async () => {
      await p
        .http('patch', '/staff/partner-settings', s.manager.token, {
          newDays: 10,
          deskLinkDays: 30,
        })
        .expect(200);
      const row = await single('partner.settings_changed', s.c.tenantId);
      expect(row).toMatchObject(by(s.manager, 'tenant'));
      expect(row.changes).toEqual({
        newDays: { from: 30, to: 10 },
        deskLinkDays: { from: 90, to: 30 },
      });
    });
  });

  describe('requests, the desk and the relay', () => {
    let partnerId: string;
    let token: string;
    const ask = async (over: Record<string, unknown> = {}) =>
      (await p.request(s.alice, s.homeA.id, partnerId, over)).id;
    const actor = (who: Who) => ({
      actorType: 'account',
      actorId: who.id,
      targetType: 'partner_request',
    });
    const system = { actorType: 'system', actorId: null };

    beforeAll(async () => {
      partnerId = await p.partner(s.c, s.keeper);
      await p.consent(s.alice);
      await p
        .http('patch', '/staff/partner-settings', s.manager.token, {
          maxLiveRequests: 20,
        })
        .expect(200);
    });

    it('partner_desk_link.created and .revoked — ids, the end and counts; never the token', async () => {
      const first = await p.deskLink(s.keeper, partnerId);
      token = await p.deskLink(s.keeper, partnerId);
      const created = await rows('partner_desk_link.created', partnerId);
      expect(created).toHaveLength(2);
      expect(created[1]).toMatchObject({
        ...actor(s.keeper),
        targetType: 'partner',
      });
      expect(created.map((r) => r.metadata)).toEqual(
        expect.arrayContaining([
          {
            deskLinkId: expect.any(String) as string,
            expiresAt: expect.any(String) as string,
            revokedCount: 1,
          },
        ]),
      );
      for (const row of created) {
        expect(JSON.stringify(row)).not.toContain(first);
        expect(JSON.stringify(row)).not.toContain(token);
      }
      const other = await p.partner(s.c, s.keeper);
      await p.deskLink(s.keeper, other);
      await p
        .http(
          'post',
          `/staff/partners/${other}/desk-link/revoke`,
          s.keeper.token,
        )
        .expect(204);
      const revoked = await single('partner_desk_link.revoked', other);
      expect(revoked.metadata).toEqual({ revokedCount: 1 });
    });

    it('partner_request.created — ids, codes, counts and the window; never the note', async () => {
      const id = await ask({ note: `${MARKER} ring twice` });
      const row = await single('partner_request.created', id);
      expect(row).toMatchObject(actor(s.alice));
      expect(row.metadata).toMatchObject({
        partnerId,
        unitId: s.homeA.id,
        category: 'home_services',
        gatePass: true,
        itemCount: 0,
        note: true,
        startsAt: expect.any(String) as string,
        endsAt: expect.any(String) as string,
      });
    });

    it('partner_desk.looked_up — the system, ids and counts', async () => {
      await p.desk(token, '/lookup').expect(200);
      const found = await rows('partner_desk.looked_up', partnerId);
      expect(found.at(-1)).toMatchObject({ ...system, targetType: 'partner' });
      expect(found.at(-1)!.metadata).toEqual({
        deskLinkId: expect.any(String) as string,
        requestCount: expect.any(Number) as number,
        withheldCount: 0,
      });
    });

    it('partner_request.accepted on the desk — the system, via the desk, the window and the staff', async () => {
      const id = await ask();
      await p
        .desk(token, `/requests/${id}/accept`, { staffCount: 2 })
        .expect(200);
      const row = await single('partner_request.accepted', id);
      expect(row).toMatchObject({ ...system, targetType: 'partner_request' });
      expect(row.metadata).toMatchObject({
        from: 'pending',
        to: 'accepted',
        via: 'partner_desk',
        deskLinkId: expect.any(String) as string,
        staffCount: 2,
      });
    });

    it('partner_request.declined through the relay — the staff member, via the relay, the code', async () => {
      const id = await ask();
      await p
        .http('post', `/staff/partner-requests/${id}/decline`, s.keeper.token, {
          reasonCode: 'not_offered',
        })
        .expect(200);
      const row = await single('partner_request.declined', id);
      expect(row).toMatchObject(actor(s.keeper));
      expect(row.metadata).toMatchObject({
        via: 'relay',
        reasonCode: 'not_offered',
      });
    });

    it('partner_request.proposed, .proposal_accepted and .cancelled (a proposal declined)', async () => {
      const window = p.windowOf(15, 16, 3);
      const yes = await ask();
      await p.desk(token, `/requests/${yes}/propose`, window).expect(200);
      await p
        .http('post', `/partner-requests/${yes}/accept-proposal`, s.alice.token)
        .expect(200);
      expect(
        (await single('partner_request.proposed', yes)).metadata,
      ).toMatchObject({ via: 'partner_desk', startsAt: window.windowStartsAt });
      expect(
        await single('partner_request.proposal_accepted', yes),
      ).toMatchObject(actor(s.alice));
      const no = await ask();
      await p.desk(token, `/requests/${no}/propose`, window).expect(200);
      await p
        .http('post', `/partner-requests/${no}/decline-proposal`, s.alice.token)
        .expect(200);
      expect(
        (await single('partner_request.cancelled', no)).metadata,
      ).toMatchObject({ via: 'resident', reasonCode: 'proposal_declined' });
    });

    it('partner_request.done and .no_show — the resident, once the window allows', async () => {
      const done = await ask();
      await p.desk(token, `/requests/${done}/accept`).expect(200);
      await shiftWindow(done, 'started');
      await p
        .http('post', `/partner-requests/${done}/done`, s.alice.token)
        .expect(200);
      expect(await single('partner_request.done', done)).toMatchObject(
        actor(s.alice),
      );
      const absent = await ask();
      await p.desk(token, `/requests/${absent}/accept`).expect(200);
      await shiftWindow(absent, 'ended');
      await p
        .http('post', `/partner-requests/${absent}/no-show`, s.alice.token)
        .expect(200);
      expect(await single('partner_request.no_show', absent)).toMatchObject(
        actor(s.alice),
      );
    });

    it('partner_request.expired and .lapsed — the system, by the sweeps', async () => {
      const expired = await ask();
      await shiftWindow(expired, 'started');
      await p.sweep(PARTNER_EXPIRE_SWEEP);
      expect(await single('partner_request.expired', expired)).toMatchObject({
        ...system,
        targetType: 'partner_request',
      });
      const lapsed = await ask();
      await p.desk(token, `/requests/${lapsed}/accept`).expect(200);
      await shiftWindow(lapsed, 'ended');
      await asSuperuser(
        `UPDATE partner_requests
            SET asked_starts_at = asked_starts_at - interval '8 days',
                asked_ends_at = asked_ends_at - interval '8 days',
                agreed_starts_at = agreed_starts_at - interval '8 days',
                agreed_ends_at = agreed_ends_at - interval '8 days'
          WHERE id = $1`,
        [lapsed],
      );
      await p.sweep(PARTNER_LAPSE_SWEEP);
      expect(
        (await single('partner_request.lapsed', lapsed)).metadata,
      ).toMatchObject({ from: 'accepted', to: 'lapsed', via: 'system' });
    });
  });

  describe('ratings and complaints', () => {
    let partnerId: string;
    let token: string;
    /** A request done: accepted on the desk, its window started, said done. */
    const done = async () => {
      const id = (await p.request(s.alice, s.homeA.id, partnerId)).id;
      await p.desk(token, `/requests/${id}/accept`).expect(200);
      await shiftWindow(id, 'started');
      await p
        .http('post', `/partner-requests/${id}/done`, s.alice.token)
        .expect(200);
      return id;
    };

    beforeAll(async () => {
      partnerId = await p.partner(s.c, s.keeper);
      token = await p.deskLink(s.keeper, partnerId);
      await p.consent(s.alice);
    });

    it('partner_request.rated — that it was, never how', async () => {
      const id = await done();
      await p
        .http('post', `/partner-requests/${id}/rating`, s.alice.token, {
          stars: 2,
          comment: `${MARKER} late again`,
        })
        .expect(200);
      const row = await single('partner_request.rated', id);
      expect(row).toMatchObject({
        actorType: 'account',
        actorId: s.alice.id,
        targetType: 'partner_request',
      });
      expect(row.metadata).toEqual({
        number: expect.any(Number) as number,
        partnerId,
        comment: true,
      });
    });

    it('partner_complaint.created and .decided — codes, ids and the amount; never the words', async () => {
      const id = await done();
      const res = await p
        .http('post', `/partner-requests/${id}/complaint`, s.alice.token, {
          reason: 'damage',
          compensationAsk: 'damages',
          requestedAmount: '300',
          message: `${MARKER} they broke the vase`,
        })
        .expect(201);
      const complaintId = (res.body as { id: string }).id;
      const created = await single('partner_complaint.created', complaintId);
      expect(created).toMatchObject({
        actorType: 'account',
        actorId: s.alice.id,
        targetType: 'partner_complaint',
      });
      expect(created.metadata).toMatchObject({
        requestId: id,
        partnerId,
        reason: 'damage',
        compensationAsk: 'damages',
        requestedAmount: '300',
        managementRequestId: expect.any(String) as string,
      });
      await p
        .http(
          'post',
          `/staff/partner-complaints/${complaintId}/decide`,
          s.keeper.token,
          { outcome: 'upheld', compensation: 'partner_refund' },
        )
        .expect(200);
      const decided = await single('partner_complaint.decided', complaintId);
      expect(decided).toMatchObject({
        actorType: 'account',
        actorId: s.keeper.id,
      });
      expect(decided.metadata).toEqual({
        requestId: id,
        partnerId,
        outcome: 'upheld',
        compensation: 'partner_refund',
      });
    });
  });

  describe('suspension', () => {
    it('partner.suspended and .reinstated — the code and counts; never who was told', async () => {
      const id = await p.partner(s.c, s.keeper);
      await p.consent(s.bob);
      await p.request(s.bob, s.homeB.id, id);
      await p
        .http('put', `/partners/${id}/favourite`, s.alice.token)
        .expect(204);
      await p
        .http('post', `/staff/partners/${id}/suspend`, s.keeper.token, {
          reasonCode: 'quality_complaints',
        })
        .expect(200);
      const suspended = await single('partner.suspended', id);
      expect(suspended).toMatchObject(by(s.keeper, 'partner'));
      expect(suspended.metadata).toEqual({
        reasonCode: 'quality_complaints',
        cancelledCount: 1,
        notifiedCount: 2,
      });
      await p
        .http('post', `/staff/partners/${id}/reinstate`, s.keeper.token)
        .expect(200);
      const reinstated = await single('partner.reinstated', id);
      expect(reinstated.metadata).toEqual({ reasonCode: 'quality_complaints' });
    });
  });

  describe('catalog completeness', () => {
    it('every partners entry has a scenario above, and nothing of the domain is left out of the list', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PARTNERS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...PARTNERS_COVERAGE].sort());
      expect(all.filter((k) => /^partner[._]/.test(k)).sort()).toEqual(
        [...PARTNERS_COVERAGE].sort(),
      );
    });
  });
});
