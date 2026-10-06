import { HouseholdsService } from '../../src/community/households/households.service';
import { ResidentsService } from '../../src/community';
import { dispatchHelpers } from '../setup/dispatch';
import { fileHelpers } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;

/**
 * ADR 0032, 0034: a reporter who lost `tickets` on the ticket's unit — they
 * left, were removed, lost the permission or stopped residing — still reads
 * the ticket, but its thread and photos only up to that moment; never its
 * visits, and no ticket notice reaches them any more. A reporter who still
 * has `tickets` is unaffected.
 */
describe('Maintenance — a reporter who left', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let primaryFirstName: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    const primary = await d.inTenant(s.c, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: s.owner.id } }),
    );
    primaryFirstName = primary.fullName!.split(' ')[0];
  }, 90_000);

  afterAll(() => h.close());

  // --- helpers ---------------------------------------------------------------

  const tech = () => s.techs[0];

  /** A residing co-owner of the unit: has `tickets`, is not the primary. */
  async function coOwner(): Promise<Who> {
    const r = await d.x.resident(s.c, [s.unit.id]);
    return d.who(s.c, r.id, 'resident');
  }

  /** An adult member of the household (with `tickets`, a default grant). */
  async function member(
    unitId = s.unit.id,
    primary: { id: string } = s.owner,
    input = {},
  ) {
    const joined = await d.x.joinFamily(s.c, unitId, primary, input);
    return {
      ...joined,
      token: await h.tokenFor({
        sub: joined.id,
        tid: s.c.tenantId,
        typ: 'family',
      }),
    };
  }

  /** A ticket `reporter` opens on the unit, assigned to the technician. */
  async function assigned(reporter: Who): Promise<string> {
    const opened = await d
      .http('post', '/tickets', reporter.token, {
        unitId: s.unit.id,
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Reporter fixture',
      })
      .expect(201);
    const id = (opened.body as { id: string }).id;
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech().id,
      })
      .expect(204);
    return id;
  }

  const say = (who: Who, id: string, body: string) =>
    d.http('post', `/tickets/${id}/messages`, who.token, { body }).expect(201);

  const thread = async (who: Who, id: string) =>
    (
      (await d.http('get', `/tickets/${id}/messages`, who.token).expect(200))
        .body as {
        data: { body: string | null; sender: { firstName?: string } }[];
      }
    ).data;

  const photos = async (who: Who, id: string) =>
    (
      (await d.http('get', `/tickets/${id}`, who.token).expect(200)).body as {
        photos: { id: string }[];
      }
    ).photos.map((p) => p.id);

  /** A report photo the reporter adds; its attachment id. */
  const reportPhoto = async (who: Who, id: string) =>
    (
      (
        await d
          .http('post', `/tickets/${id}/photos`, who.token, {
            fileId: await fileHelpers(h).ready(who.token, 'ticket_photo'),
          })
          .expect(201)
      ).body as { id: string }
    ).id;

  const endOccupancy = async (accountId: string) => {
    const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
      (o) => o.accountId === accountId && o.status === 'active',
    )!;
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(ResidentsService)
        .endOccupancy(occupancy.id, { code: 'moved_out', text: 'Left' }),
    );
  };

  /** The notices of a ticket, as [kind, recipient]. */
  const notices = (ticketId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.notification.findMany({
          where: { targetId: ticketId },
          orderBy: { createdAt: 'asc' },
        })
      ).map((n) => [n.kind, n.accountId] as const),
    );

  const window = (inMinutes = 24 * 60, minutes = 60) => {
    const start = Date.now() + inMinutes * MINUTE;
    return {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + minutes * MINUTE).toISOString(),
    };
  };

  // --- visits ------------------------------------------------------------------

  it('reads no visit of their ticket (403 TICKETS_NOT_ALLOWED); a reporter who still lives there does', async () => {
    const leaver = await coOwner();
    const stayer = await coOwner();
    const left = await assigned(leaver);
    const kept = await assigned(stayer);
    for (const id of [left, kept])
      await d
        .http(
          'post',
          `/technician/tickets/${id}/visits`,
          tech().token,
          window(),
        )
        .expect(201);
    await d.http('get', `/tickets/${left}/visits`, leaver.token).expect(200);
    await endOccupancy(leaver.id);

    // The ticket itself stays readable (ADR 0032); its visits do not.
    await d.http('get', `/tickets/${left}`, leaver.token).expect(200);
    const refused = await d
      .http('get', `/tickets/${left}/visits`, leaver.token)
      .expect(403);
    expect((refused.body as { code: string }).code).toBe('TICKETS_NOT_ALLOWED');
    const listed = await d
      .http('get', `/tickets/${kept}/visits`, stayer.token)
      .expect(200);
    expect((listed.body as { data: unknown[] }).data).toHaveLength(1);
  });

  // --- notices -----------------------------------------------------------------

  it('after the end, a message, a status change and a visit change reach the household, never the reporter who left', async () => {
    const leaver = await coOwner();
    const id = await assigned(leaver);
    await endOccupancy(leaver.id);
    const since = (await notices(id)).length;

    await d
      .http('post', `/technician/tickets/${id}/messages`, tech().token, {
        body: 'On my way',
      })
      .expect(201);
    await d
      .http('post', `/technician/tickets/${id}/start`, tech().token)
      .expect(204);
    await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, window())
      .expect(201);

    const after = (await notices(id)).slice(since);
    const to = (kind: string) =>
      after.filter(([k]) => k === kind).map(([, accountId]) => accountId);
    // The message and the visit reach the primary. A status change goes to
    // the reporter only (ADR 0032): it was written, and told nobody here.
    expect(to('ticket.message')).toContain(s.owner.id);
    expect(to('ticket.visit_proposed')).toContain(s.owner.id);
    expect((await d.ticketRow(s.c, id)).status).toBe('in_progress');
    expect(after.map(([, accountId]) => accountId)).not.toContain(leaver.id);
  });

  it('a reporter who still has `tickets` is told as before', async () => {
    const stayer = await coOwner();
    const id = await assigned(stayer);
    await d
      .http('post', `/technician/tickets/${id}/messages`, tech().token, {
        body: 'On my way',
      })
      .expect(201);
    await d
      .http('post', `/technician/tickets/${id}/start`, tech().token)
      .expect(204);
    await d
      .http('post', `/technician/tickets/${id}/visits`, tech().token, window())
      .expect(201);
    const told = (await notices(id))
      .filter(([, accountId]) => accountId === stayer.id)
      .map(([kind]) => kind);
    expect(told).toEqual(
      expect.arrayContaining([
        'ticket.message',
        'ticket.status_changed',
        'ticket.visit_proposed',
      ]),
    );
  });

  // --- the thread and the photos ---------------------------------------------

  it('after the end, the thread and the photos up to the end only; the primary reads all of it', async () => {
    const leaver = await coOwner();
    const id = await assigned(leaver);
    const before = await reportPhoto(leaver, id);
    await say(s.owner, id, 'Written before the end');
    await endOccupancy(leaver.id);
    await say(s.owner, id, 'Written after the end');
    await d
      .http('post', `/technician/tickets/${id}/start`, tech().token)
      .expect(204);
    const later = (
      (
        await d
          .http('post', `/technician/tickets/${id}/photos`, tech().token, {
            fileId: await fileHelpers(h).ready(tech().token, 'ticket_photo'),
            kind: 'before',
          })
          .expect(201)
      ).body as { id: string }
    ).id;

    const seen = await thread(leaver, id);
    expect(seen.map((m) => m.body)).toEqual(['Written before the end']);
    // Positive control: the household member's first name is there.
    expect(seen[0].sender.firstName).toBe(primaryFirstName);
    expect(await photos(leaver, id)).toEqual([before]);

    expect((await thread(s.owner, id)).map((m) => m.body)).toEqual([
      'Written before the end',
      'Written after the end',
    ]);
    expect(await photos(s.owner, id)).toEqual([before, later]);
  });

  it('the cut is when `tickets` was lost: a removal, a revoked grant; an owner who stopped residing (no time recorded) sees none', async () => {
    // A member of two households: removed from this one, still signed in.
    const removed = await member();
    const elsewhere = await d.x.unit(s.c);
    const again = await member(
      elsewhere.id,
      await d.x.resident(s.c, [elsewhere.id]),
      {
        fullName: removed.fullName,
        email: removed.email,
        phone: removed.phone,
        idDocumentNumber: removed.idDocumentNumber,
      },
    );
    // The same family account (invite acceptance reuses it by email).
    expect(again.id).toBe(removed.id);
    const revoked = await member();
    const landlord = await coOwner();

    const cases = [
      {
        who: removed,
        lose: () =>
          d.x.as(s.c, { id: s.owner.id, type: 'resident' }, () =>
            h.moduleRef.get(HouseholdsService).removeMember(removed.memberId, {
              code: 'moved_out',
              text: 'Moved out',
            }),
          ),
        expected: ['Before'],
      },
      {
        who: revoked,
        lose: () =>
          d
            .http(
              'post',
              `/household/members/${revoked.memberId}/permissions/revoke`,
              s.owner.token,
              {
                permission: 'tickets',
                reasonCode: 'no_longer_needed',
                reason: 'Not any more',
              },
            )
            .expect(204),
        expected: ['Before'],
      },
      {
        who: landlord,
        lose: async () => {
          const occupancy = (await d.x.occupancies(s.c, s.unit.id)).find(
            (o) => o.accountId === landlord.id && o.status === 'active',
          )!;
          await d.x.asManager(s.c, () =>
            h.moduleRef.get(ResidentsService).setResidence(occupancy.id, false),
          );
        },
        expected: [],
      },
    ];
    for (const c of cases) {
      const id = await assigned(c.who);
      const photo = await reportPhoto(c.who, id);
      await say(s.owner, id, 'Before');
      await c.lose();
      await say(s.owner, id, 'After');
      expect((await thread(c.who, id)).map((m) => m.body)).toEqual(c.expected);
      expect(await photos(c.who, id)).toEqual(c.expected.length ? [photo] : []);
    }
  });

  it('internal messages stay hidden, before the end as after', async () => {
    const leaver = await coOwner();
    const id = await assigned(leaver);
    await d
      .http('post', `/technician/tickets/${id}/messages`, tech().token, {
        body: 'Staff only',
        internal: true,
      })
      .expect(201);
    expect(await thread(leaver, id)).toEqual([]);
    await endOccupancy(leaver.id);
    expect(await thread(leaver, id)).toEqual([]);
  });
});
