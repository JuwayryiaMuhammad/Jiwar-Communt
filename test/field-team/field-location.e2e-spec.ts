import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { LOCATION_PURGE_SWEEP } from '../../src/maintenance/field-location/field-location.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { dispatchHelpers } from '../setup/dispatch';
import { engagementHelpers } from '../setup/engagement';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;
// eslint-disable-next-line no-restricted-syntax -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
const DAY = 86_400_000;
/** Coordinates nobody else uses: they must show only where they may. */
const HERE = { latitude: 29.987654, longitude: 31.123456, accuracyMeters: 12 };

interface Mine {
  consent: { grantedAt: string } | null;
  points: { moment: string; ticketId: string; latitude: number }[];
}
interface Last {
  technicianId: string;
  consent: boolean;
  last: {
    moment: string;
    ticketId: string;
    ticketNumber: string | null;
    latitude: number;
    longitude: number;
    accuracyMeters: number | null;
  } | null;
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

/**
 * ADR 0090: a technician's last known location, only with their consent —
 * recorded, revocable, audited — and only at three steps of one of their
 * tickets: on the way, at the door, starting the work. Kept 30 days, read
 * one technician at a time by the field team and the dispatch, never in a
 * resident's view.
 */
describe('A technician’s last known location', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(3);
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  const consent = (as: Who, method: 'get' | 'post' | 'delete') =>
    d.http(method, '/technician/location-consent', as.token);
  const last = (as: Who, technicianId: string) =>
    d.http(
      'get',
      `/staff/field-team/technicians/${technicianId}/location`,
      as.token,
    );

  /** A ticket of the owner's, assigned to `tech`; its id. */
  async function assigned(tech: Who): Promise<string> {
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech.id,
      })
      .expect(204);
    return id;
  }

  it('consent is the technician’s own: given once, revoked, audited', async () => {
    const tech = s.techs[0];
    expect((await consent(tech, 'get').expect(200)).body).toEqual({
      consent: null,
      points: [],
    });
    const given = (await consent(tech, 'post').expect(200)).body as Mine;
    expect(given.consent).not.toBeNull();
    // Again: the same, and audited once.
    expect((await consent(tech, 'post').expect(200)).body).toEqual(given);
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'technician_location.consent_granted',
        targetId: tech.id,
      }),
    ).toHaveLength(1);
    // A resident has no such consent to give.
    expect((await consent(s.owner, 'post')).status).toBe(403);
    expect(
      ((await consent(tech, 'delete').expect(200)).body as Mine).consent,
    ).toBeNull();
    // None to revoke: nothing changes, nothing is audited.
    await consent(tech, 'delete').expect(200);
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'technician_location.consent_revoked',
        targetId: tech.id,
      }),
    ).toEqual([
      expect.objectContaining({
        actorId: tech.id,
        metadata: { by: 'self', removed: 0 },
      }),
    ]);
  });

  it('without consent, a step with a location is refused and nothing moves; without a location it goes as before', async () => {
    const tech = s.techs[1];
    const id = await assigned(tech);
    expect(
      code(
        await d.http('post', `/technician/tickets/${id}/en-route`, tech.token, {
          location: HERE,
        }),
      ),
    ).toEqual({ status: 409, code: 'LOCATION_CONSENT_REQUIRED' });
    expect((await d.ticketRow(s.c, id)).status).toBe('assigned');
    await d
      .http('post', `/technician/tickets/${id}/en-route`, tech.token)
      .expect(204);
    expect((await d.ticketRow(s.c, id)).status).toBe('en_route');
    const bad = await d.http(
      'post',
      `/technician/tickets/${id}/start`,
      tech.token,
      { location: { latitude: 91, longitude: 0 } },
    );
    expect(bad.status).toBe(400);
  });

  it('with consent: a point on the way, one starting the work, one at the door; the latest read by the field team, audited', async () => {
    const tech = s.techs[2];
    await consent(tech, 'post').expect(200);
    const first = await assigned(tech);
    await d
      .http('post', `/technician/tickets/${first}/en-route`, tech.token, {
        location: HERE,
      })
      .expect(204);
    await d
      .http('post', `/technician/tickets/${first}/start`, tech.token, {
        location: { latitude: 30.1, longitude: 31.2 },
      })
      .expect(204);
    // At the door of a visit: one point, `arrived`, though it starts the work.
    const second = await assigned(tech);
    const startsAt = Date.now() + 20 * MINUTE;
    const visit = (
      await d
        .http('post', `/technician/tickets/${second}/visits`, tech.token, {
          startsAt: new Date(startsAt).toISOString(),
          endsAt: new Date(startsAt + 60 * MINUTE).toISOString(),
        })
        .expect(201)
    ).body as { id: string };
    await d
      .http(
        'post',
        `/tickets/${second}/visits/${visit.id}/confirm`,
        s.owner.token,
      )
      .expect(204);
    await d
      .http(
        'post',
        `/technician/tickets/${second}/visits/${visit.id}/arrive`,
        tech.token,
        { location: HERE },
      )
      .expect(200);
    expect((await d.ticketRow(s.c, second)).status).toBe('in_progress');

    const mine = (await consent(tech, 'get').expect(200)).body as Mine;
    expect(mine.points.map((p) => [p.moment, p.ticketId])).toEqual([
      ['arrived', second],
      ['started', first],
      ['en_route', first],
    ]);
    for (const reader of [s.supervisor, s.manager]) {
      const read = (await last(reader, tech.id).expect(200)).body as Last;
      expect(read).toMatchObject({
        technicianId: tech.id,
        consent: true,
        last: {
          moment: 'arrived',
          ticketId: second,
          latitude: HERE.latitude,
          longitude: HERE.longitude,
          accuracyMeters: 12,
        },
      });
    }
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'technician_location.read',
        targetId: tech.id,
      }),
    ).toEqual([
      expect.objectContaining({
        actorId: s.supervisor.id,
        metadata: { found: true, moment: 'arrived' },
      }),
      expect.objectContaining({ actorId: s.manager.id }),
    ]);
    // Never to another technician, never to a resident.
    expect((await last(s.techs[0], tech.id)).status).toBe(403);
    expect((await last(s.owner, tech.id)).status).toBe(403);
    expect(code(await last(s.supervisor, s.owner.id))).toEqual({
      status: 404,
      code: 'TECHNICIAN_NOT_FOUND',
    });
    // Never in the residents' view of the ticket or its visits, nor in
    // anyone's notifications.
    const seen = [
      (await d.http('get', `/tickets/${second}`, s.owner.token).expect(200))
        .text,
      (
        await d
          .http('get', `/tickets/${second}/visits`, s.owner.token)
          .expect(200)
      ).text,
      JSON.stringify(await engagementHelpers(h).notifications(s.c, s.owner.id)),
    ].join('\n');
    expect(seen).not.toContain(String(HERE.latitude));
    expect(seen).not.toContain(String(HERE.longitude));
  });

  it('revoking removes every point; leaving revokes; the 30 days’ purge', async () => {
    const tech = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    await consent(tech, 'post').expect(200);
    const id = await assigned(tech);
    await d
      .http('post', `/technician/tickets/${id}/en-route`, tech.token, {
        location: HERE,
      })
      .expect(204);
    await consent(tech, 'delete').expect(200);
    expect(
      ((await last(s.supervisor, tech.id).expect(200)).body as Last).last,
    ).toBeNull();

    // The purge: a point older than 30 days goes, a younger one stays.
    await consent(tech, 'post').expect(200);
    const live = await d.inTenant(s.c, (tx) =>
      tx.technicianLocationConsent.findFirstOrThrow({
        where: { accountId: tech.id, revokedAt: null },
      }),
    );
    const point = (ago: number) =>
      d.inTenant(s.c, (tx) =>
        tx.technicianLocation.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            accountId: tech.id,
            consentId: live.id,
            ticketId: id,
            moment: 'en_route',
            latitude: 30,
            longitude: 31,

            capturedAt: new Date(Date.now() - ago),
          },
        }),
      );
    // eslint-disable-next-line test-clock/day-multiple -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
    const old = await point(31 * DAY);
    // eslint-disable-next-line test-clock/day-multiple -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
    const young = await point(29 * DAY);
    await h.moduleRef.get(SweepRunner).run(LOCATION_PURGE_SWEEP, new Date());
    const left = await d.inTenant(s.c, (tx) =>
      tx.technicianLocation.findMany({
        where: { id: { in: [old.id, young.id] } },
        select: { id: true },
      }),
    );
    expect(left).toEqual([{ id: young.id }]);

    // Leaving: the consent ends by the system, and the points with it.
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(tech.id, { status: 'inactive' }),
    );
    expect(
      await d.inTenant(s.c, (tx) =>
        tx.technicianLocation.count({ where: { accountId: tech.id } }),
      ),
    ).toBe(0);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'technician_location.consent_revoked',
          targetId: tech.id,
        })
      ).at(-1),
    ).toMatchObject({
      // In the deactivation's transaction, as whoever deactivated.
      actorId: s.c.managerId,
      metadata: { by: 'system' },
    });
  });

  it('the technician’s export holds their consents and their points', async () => {
    const tech = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    await consent(tech, 'post').expect(200);
    const id = await assigned(tech);
    await d
      .http('post', `/technician/tickets/${id}/en-route`, tech.token, {
        location: HERE,
      })
      .expect(204);
    const { email } = await d.inTenant(s.c, (tx) =>
      tx.account.findUniqueOrThrow({
        where: { id: tech.id },
        select: { email: true },
      }),
    );
    await stepUp(h, tech.token, email!);
    const asked = await d
      .http('post', '/me/data-exports', tech.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await d
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        tech.token,
      )
      .expect(200);
    const archive = await readArchive((dl.body as { url: string }).url);
    const out = JSON.parse(archive.text('field-team/location.json')) as {
      consents: unknown[];
      points: { moment: string; latitude: number }[];
    };
    expect(out.consents).toHaveLength(1);
    expect(out.points).toEqual([
      expect.objectContaining({ moment: 'en_route', latitude: HERE.latitude }),
    ]);
  });
});
