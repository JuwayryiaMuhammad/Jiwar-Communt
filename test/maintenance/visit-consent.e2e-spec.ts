import { createHash } from 'node:crypto';
import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { HouseholdsService } from '../../src/community/households/households.service';
import { ResidentsService } from '../../src/community';
import { dispatchHelpers } from '../setup/dispatch';
import { nationalIdFor, uniquePhone } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;

/**
 * ADR 0034: absence-entry consent and the receiver. Consent is not
 * confirmation; any adult who lives in the unit (visitConsent, an active
 * account) grants it on a confirmed visit and any of them revokes it until
 * the arrival; it is never carried over. A landlord, someone who left, a
 * frozen or erased account never grants it. The primary is told when
 * someone else does. The same people, and only they, read a unit's visits
 * (`GET /me/units/{unitId}/visits`).
 */
describe('Maintenance — visit consent and the receiver', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let family: Who;
  let coOwner: Who;
  let rentedUnitId: string;
  let tenant: Who;
  let landlord: Who;
  let neighbour: Who;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    family = await member(s.unit.id, s.owner);
    const co = await d.x.resident(s.c, [s.unit.id]);
    coOwner = await d.who(s.c, co.id, 'resident');
    const rented = await d.x.unit(s.c);
    rentedUnitId = rented.id;
    const t = await d.x.resident(s.c, [rented.id], 'tenant');
    tenant = await d.who(s.c, t.id, 'resident');
    const l = await d.x.asManager(s.c, () =>
      d.x.residents.createResident({
        ...d.x.person('landlord'),
        units: [{ unitId: rented.id, occupancyType: 'owner', resides: false }],
      }),
    );
    landlord = await d.who(s.c, l.id, 'resident');
    const other = await d.x.unit(s.c);
    neighbour = await d.who(
      s.c,
      (await d.x.resident(s.c, [other.id])).id,
      'resident',
    );
  }, 120_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  async function member(unitId: string, primary: { id: string }): Promise<Who> {
    const joined = await d.x.joinFamily(s.c, unitId, primary);
    return {
      id: joined.id,
      token: await h.tokenFor({
        sub: joined.id,
        tid: s.c.tenantId,
        typ: 'family',
      }),
    };
  }

  const tech = () => s.techs[0];

  const window = (inMinutes = 20, minutes = 60) => {
    const start = Date.now() + inMinutes * MINUTE;
    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + minutes * MINUTE).toISOString(),
    };
  };

  /** A confirmed visit on a ticket `reporter` opens on `unitId`. */
  async function confirmedVisit(
    reporter: Who = s.owner,
    unitId: string = s.unit.id,
  ): Promise<{ id: string; visitId: string }> {
    const opened = await d
      .http('post', '/tickets', reporter.token, {
        unitId,
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Consent fixture',
      })
      .expect(201);
    const id = (opened.body as { id: string }).id;
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    const proposed = await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, window())
      .expect(201);
    const visitId = (proposed.body as { id: string }).id;
    await d
      .http('post', `/tickets/${id}/visits/${visitId}/confirm`, reporter.token)
      .expect(204);
    return { id, visitId };
  }

  const consent = (
    who: Who,
    v: { id: string; visitId: string },
    method: 'post' | 'delete' = 'post',
  ) =>
    method === 'post'
      ? d.http(
          'post',
          `/tickets/${v.id}/visits/${v.visitId}/absence-consent`,
          who.token,
        )
      : d.http(
          'delete',
          `/tickets/${v.id}/visits/${v.visitId}/absence-consent`,
          who.token,
        );

  const visitRow = (visitId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketVisit.findUniqueOrThrow({ where: { id: visitId } }),
    );

  const kinds = (ticketId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.ticketVisitEvent.findMany({
          where: { ticketId },
          orderBy: [{ at: 'asc' }, { id: 'asc' }],
        })
      ).map((e) => [e.kind, e.reasonCode]),
    );

  const capability = async (who: Who, unitId: string) =>
    (
      (
        await d
          .http('get', `/me/units/${unitId}/capabilities`, who.token)
          .expect(200)
      ).body as { visitConsent: boolean }
    ).visitConsent;

  // --- who may grant ---------------------------------------------------------

  it('is not implied by confirming the visit', async () => {
    const v = await confirmedVisit();
    expect(await visitRow(v.visitId)).toMatchObject({
      status: 'confirmed',
      absenceEntryApproved: false,
      consentById: null,
    });
  });

  it('the primary, an adult of the household, a residing co-owner and a residing tenant may grant it; capabilitiesFor says so', async () => {
    for (const [who, unitId, reporter] of [
      [s.owner, s.unit.id, s.owner],
      [family, s.unit.id, s.owner],
      [coOwner, s.unit.id, s.owner],
      [tenant, rentedUnitId, tenant],
    ] as const) {
      expect(await capability(who, unitId)).toBe(true);
      const v = await confirmedVisit(reporter, unitId);
      await consent(who, v).expect(204);
      expect(await visitRow(v.visitId)).toMatchObject({
        absenceEntryApproved: true,
        consentById: who.id,
      });
    }
  });

  it('a landlord (an owner who does not live there) may not; capabilitiesFor says so', async () => {
    expect(await capability(landlord, rentedUnitId)).toBe(false);
    const v = await confirmedVisit(tenant, rentedUnitId);
    const res = await consent(landlord, v);
    expect([403, 404]).toContain(res.status);
    expect((await visitRow(v.visitId)).absenceEntryApproved).toBe(false);
  });

  it('a resident of another unit may not', async () => {
    const v = await confirmedVisit();
    await consent(neighbour, v).expect(404);
  });

  it('when someone other than the primary grants it, the primary is told (the window only) and may revoke it', async () => {
    const v = await confirmedVisit();
    await consent(family, v).expect(204);
    const told = await d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { targetId: v.id, kind: 'ticket.visit_consent_granted' },
      }),
    );
    expect(told.map((n) => n.accountId)).toEqual([s.owner.id]);
    expect(Object.keys(told[0].params as object).sort()).toEqual([
      'endsAt',
      'startsAt',
      'ticketNumber',
    ]);
    await consent(s.owner, v, 'delete').expect(204);
    expect(await visitRow(v.visitId)).toMatchObject({
      absenceEntryApproved: false,
      consentById: null,
    });
    expect(await kinds(v.id)).toEqual(
      expect.arrayContaining([
        ['consent_granted', null],
        ['consent_revoked', null],
      ]),
    );
    // The primary granting it tells nobody.
    const own = await confirmedVisit();
    await consent(s.owner, own).expect(204);
    expect(
      await d.inTenant(s.c, (tx) =>
        tx.notification.count({
          where: { targetId: own.id, kind: 'ticket.visit_consent_granted' },
        }),
      ),
    ).toBe(0);
  });

  it('only on a confirmed visit, and revocable until the arrival', async () => {
    const opened = await confirmedVisit();
    await d
      .http(
        'post',
        `/technician/tickets/${opened.id}/visits/${opened.visitId}/arrive`,
        tech().token,
      )
      .expect(200);
    const late = await consent(s.owner, opened);
    expect(late.status).toBe(409);
    expect((late.body as { code: string }).code).toBe(
      'VISIT_INVALID_TRANSITION',
    );
    await consent(s.owner, opened, 'delete').expect(409);
  });

  it('rescheduling voids it: never carried over to the new visit', async () => {
    const v = await confirmedVisit();
    await consent(family, v).expect(204);
    const moved = await d
      .http(
        'post',
        `/technician/tickets/${v.id}/visits/${v.visitId}/reschedule`,
        tech().token,
        {
          ...window(90),
          reasonCode: 'technician_request',
        },
      )
      .expect(201);
    expect(await visitRow(v.visitId)).toMatchObject({
      status: 'rescheduled',
      absenceEntryApproved: false,
      consentById: null,
    });
    const next = await visitRow((moved.body as { id: string }).id);
    expect(next.absenceEntryApproved).toBe(false);
    expect(await kinds(v.id)).toContainEqual(['consent_voided', null]);
  });

  it('a granter who leaves takes the consent with them', async () => {
    const leaver = await d.x.resident(s.c, [s.unit.id]);
    const leaverWho = await d.who(s.c, leaver.id, 'resident');
    const v = await confirmedVisit();
    await consent(leaverWho, v).expect(204);
    const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
      (o) => o.accountId === leaver.id && o.status === 'active',
    )!;
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(ResidentsService)
        .endOccupancy(occupancy.id, { code: 'moved_out', text: 'Left' }),
    );
    expect(await visitRow(v.visitId)).toMatchObject({
      absenceEntryApproved: false,
      consentById: null,
    });
    expect(await kinds(v.id)).toContainEqual([
      'consent_voided',
      'granter_left',
    ]);
    // And may no longer grant it.
    expect(await capability(leaverWho, s.unit.id).catch(() => false)).toBe(
      false,
    );
    const again = await confirmedVisit();
    const res = await consent(leaverWho, again);
    // Refused: 401 if leaving also deactivated the account.
    expect([401, 403, 404]).toContain(res.status);
  });

  it('a frozen account loses its consent and may not grant one', async () => {
    const frozen = await member(s.unit.id, s.owner);
    const v = await confirmedVisit();
    await consent(frozen, v).expect(204);
    await d.x.asManager(s.c, () =>
      h.moduleRef.get(AccountsService).freeze(frozen.id, {
        code: 'phone_reassigned',
        text: 'Number reassigned',
      }),
    );
    expect((await visitRow(v.visitId)).absenceEntryApproved).toBe(false);
    const again = await confirmedVisit();
    expect((await consent(frozen, again)).status).toBe(401);
  });

  it('an erased account loses its consent and may not grant one', async () => {
    const leaving = await member(s.unit.id, s.owner);
    const v = await confirmedVisit();
    await consent(leaving, v).expect(204);
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await d.x.as(s.c, { id: leaving.id, type: 'family' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await d.x.asManager(s.c, () =>
      d.x.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await d.x.asManager(s.c, () =>
      deletion.erase(request.id, scopePhrase(leaving.id)),
    );
    expect((await visitRow(v.visitId)).absenceEntryApproved).toBe(false);
    const again = await confirmedVisit();
    expect((await consent(leaving, again)).status).toBe(401);
  });

  // --- the race --------------------------------------------------------------

  it('an arrival and a revocation at once: one wins, and what the technician was told is what holds', async () => {
    for (let round = 0; round < 5; round++) {
      const v = await confirmedVisit();
      await consent(family, v).expect(204);
      const [arrive, revoke] = await Promise.all([
        d.http(
          'post',
          `/technician/tickets/${v.id}/visits/${v.visitId}/arrive`,
          tech().token,
        ),
        consent(s.owner, v, 'delete'),
      ]);
      expect(arrive.status).toBe(200);
      const row = await visitRow(v.visitId);
      expect(row.status).toBe('arrived');
      const told = (arrive.body as { absenceEntryApproved: boolean })
        .absenceEntryApproved;
      expect(told).toBe(row.absenceEntryApproved);
      if (revoke.status === 204) {
        // Revoked first: the technician arrived without consent.
        expect(row.absenceEntryApproved).toBe(false);
        expect(row.consentById).toBeNull();
      } else {
        // Arrived first: the consent stands, and revoking is too late.
        expect(revoke.status).toBe(409);
        expect(row).toMatchObject({
          absenceEntryApproved: true,
          consentById: family.id,
        });
      }
    }
  });

  // --- the receiver ------------------------------------------------------------

  /** An active domestic worker of the unit (setup, not a test). */
  async function worker(unitId: string): Promise<string> {
    return d.inTenant(s.c, async (tx) => {
      const workerId = newId();
      const doc = nationalIdFor();
      await tx.domesticWorker.create({
        data: {
          id: workerId,
          tenantId: s.c.tenantId,
          idDocumentHash: createHash('sha256').update(doc).digest('hex'),
          idDocumentNumber: doc,
          fullName: 'Amal Receiver Worker',
          phone: uniquePhone(),
          birthDate: new Date(Date.UTC(1990, 0, 1)),
        },
      });
      const engagementId = newId();
      await tx.workerEngagement.create({
        data: {
          id: engagementId,
          tenantId: s.c.tenantId,
          workerId,
          unitId,
          requestedById: s.owner.id,
          capacity: 'hourly',
          schedule: {},
          status: 'active',
          accessCodeHash: createHash('sha256').update(newId()).digest('hex'),
        },
      });
      return engagementId;
    });
  }

  const technicianView = async (v: { id: string; visitId: string }) =>
    (
      (
        await d
          .http('get', `/technician/tickets/${v.id}/visits`, tech().token)
          .expect(200)
      ).body as {
        data: {
          id: string;
          receiver: unknown;
          absenceEntryApproved: boolean;
        }[];
      }
    ).data.find((x) => x.id === v.visitId)!;

  it('a household adult or an active worker receives the technician; the technician sees a first name and a kind', async () => {
    const v = await confirmedVisit();
    await d
      .http(
        'put',
        `/tickets/${v.id}/visits/${v.visitId}/receiver`,
        s.owner.token,
        {
          accountId: family.id,
        },
      )
      .expect(204);
    const seen = await technicianView(v);
    expect(seen.receiver).toEqual({
      kind: 'household',
      firstName: expect.any(String) as string,
    });
    expect(JSON.stringify(seen)).not.toContain(family.id);
    const engagementId = await worker(s.unit.id);
    await d
      .http(
        'put',
        `/tickets/${v.id}/visits/${v.visitId}/receiver`,
        s.owner.token,
        {
          engagementId,
        },
      )
      .expect(204);
    expect((await technicianView(v)).receiver).toEqual({
      kind: 'worker',
      firstName: 'Amal',
    });
    // Ending the engagement: the worker no longer receives anyone.
    await d.inTenant(s.c, (tx) =>
      tx.workerEngagement.update({
        where: { id: engagementId },
        data: { status: 'ended', accessCodeHash: null },
      }),
    );
    expect((await technicianView(v)).receiver).toBeNull();
  });

  it('refuses a receiver who does not live there, or a worker of another unit', async () => {
    const v = await confirmedVisit();
    const res = await d
      .http(
        'put',
        `/tickets/${v.id}/visits/${v.visitId}/receiver`,
        s.owner.token,
        {
          accountId: neighbour.id,
        },
      )
      .expect(400);
    expect((res.body as { fields: unknown[] }).fields).toEqual([
      { field: 'accountId', code: 'RECEIVER_NOT_ELIGIBLE' },
    ]);
    const elsewhere = await worker(rentedUnitId);
    const other = await d
      .http(
        'put',
        `/tickets/${v.id}/visits/${v.visitId}/receiver`,
        s.owner.token,
        {
          engagementId: elsewhere,
        },
      )
      .expect(400);
    expect((other.body as { fields: unknown[] }).fields).toEqual([
      { field: 'engagementId', code: 'RECEIVER_NOT_ELIGIBLE' },
    ]);
  });

  it('a receiver who leaves the household is cleared', async () => {
    const receiver = await member(s.unit.id, s.owner);
    const v = await confirmedVisit();
    await d
      .http(
        'put',
        `/tickets/${v.id}/visits/${v.visitId}/receiver`,
        s.owner.token,
        {
          accountId: receiver.id,
        },
      )
      .expect(204);
    const memberRow = await d.inTenant(s.c, (tx) =>
      tx.householdMember.findFirstOrThrow({
        where: { accountId: receiver.id, status: 'active' },
      }),
    );
    await d.x.as(s.c, { id: s.owner.id, type: 'resident' }, () =>
      h.moduleRef
        .get(HouseholdsService)
        .removeMember(memberRow.id, { code: 'moved_out', text: 'Moved out' }),
    );
    expect(await visitRow(v.visitId)).toMatchObject({
      receiverKind: null,
      receiverAccountId: null,
    });
    expect(await kinds(v.id)).toContainEqual(['receiver_cleared', null]);
  });

  it('a granter who stops residing (an owner turned landlord) takes the consent with them; the technician sees none', async () => {
    const owner = await d.x.resident(s.c, [s.unit.id]);
    const ownerWho = await d.who(s.c, owner.id, 'resident');
    const v = await confirmedVisit();
    await consent(ownerWho, v).expect(204);
    expect((await technicianView(v)).absenceEntryApproved).toBe(true);
    const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
      (o) => o.accountId === owner.id && o.status === 'active',
    )!;
    await d.x.asManager(s.c, () =>
      h.moduleRef.get(ResidentsService).setResidence(occupancy.id, false),
    );
    expect(await visitRow(v.visitId)).toMatchObject({
      absenceEntryApproved: false,
      consentById: null,
    });
    expect(await kinds(v.id)).toContainEqual([
      'consent_voided',
      'granter_left',
    ]);
    expect((await technicianView(v)).absenceEntryApproved).toBe(false);
    // A granter who still lives there is unaffected.
    const kept = await confirmedVisit();
    await consent(coOwner, kept).expect(204);
    expect((await technicianView(kept)).absenceEntryApproved).toBe(true);
  });

  // --- who reads a unit's visits ---------------------------------------------

  it('GET /me/units/{unitId}/visits: an adult who lives there; a landlord or someone who left is refused, a frozen or erased account is signed out', async () => {
    const unitVisits = (token: string, unitId: string) =>
      d.http('get', `/me/units/${unitId}/visits`, token);
    const listed = (res: { body: unknown }) =>
      (res.body as { data: { id: string }[] }).data.map((v) => v.id);
    const code = (res: { body: unknown }) =>
      (res.body as { code: string }).code;
    // A visit on each unit, so a 200 would carry one.
    const rented = await confirmedVisit(tenant, rentedUnitId);
    const home = await confirmedVisit();

    // The landlord, on the unit it rents out: it has a place there, without
    // visitConsent. Its residing primary, on the same unit, reads it.
    expect(
      code(await unitVisits(landlord.token, rentedUnitId).expect(403)),
    ).toBe('VISITS_NOT_ALLOWED');
    expect(
      listed(await unitVisits(tenant.token, rentedUnitId).expect(200)),
    ).toContain(rented.visitId);
    // The residing primary and an active adult member with an account.
    for (const who of [s.owner, family])
      expect(
        listed(await unitVisits(who.token, s.unit.id).expect(200)),
      ).toContain(home.visitId);

    // Someone whose occupancy ended: the archive is still a place (so not
    // 404), and it carries no visitConsent.
    const leaver = await d.x.resident(s.c, [s.unit.id]);
    const leaverWho = await d.who(s.c, leaver.id, 'resident');
    await unitVisits(leaverWho.token, s.unit.id).expect(200);
    const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
      (o) => o.accountId === leaver.id && o.status === 'active',
    )!;
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(ResidentsService)
        .endOccupancy(occupancy.id, { code: 'moved_out', text: 'Left' }),
    );
    expect(code(await unitVisits(leaverWho.token, s.unit.id).expect(403))).toBe(
      'VISITS_NOT_ALLOWED',
    );

    // Frozen and erased: a session started after the change, so the 401 is
    // the account's status, not the sessions the change revoked.
    const fresh = (id: string) =>
      h.tokenFor({ sub: id, tid: s.c.tenantId, typ: 'family' });
    const frozen = await member(s.unit.id, s.owner);
    await unitVisits(frozen.token, s.unit.id).expect(200);
    await d.x.asManager(s.c, () =>
      h.moduleRef.get(AccountsService).freeze(frozen.id, {
        code: 'phone_reassigned',
        text: 'Number reassigned',
      }),
    );
    expect(
      code(await unitVisits(await fresh(frozen.id), s.unit.id).expect(401)),
    ).toBe('UNAUTHENTICATED');

    const erased = await member(s.unit.id, s.owner);
    await unitVisits(erased.token, s.unit.id).expect(200);
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await d.x.as(s.c, { id: erased.id, type: 'family' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await d.x.asManager(s.c, () =>
      d.x.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await d.x.asManager(s.c, () =>
      deletion.erase(request.id, scopePhrase(erased.id)),
    );
    expect(
      code(await unitVisits(await fresh(erased.id), s.unit.id).expect(401)),
    ).toBe('UNAUTHENTICATED');
  });
});
