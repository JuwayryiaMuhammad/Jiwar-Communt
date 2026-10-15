import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { safetyHelpers, type PlaceBody, type Who } from '../setup/safety';

/**
 * ADR 0047: an account's emergencies and gate services when it goes, and
 * in its export. Deactivated or erased, its requests that are not over are
 * cancelled by the system; erased, what it wrote and its photo go, once,
 * and security's notes stay. Its export holds its own, and of an emergency
 * it was only alerted to, codes and times — never who reported.
 */
describe('Safety — privacy', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof safetyHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof safetyHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let places: Record<string, PlaceBody>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = safetyHelpers(h);
    s = await x.setUp('Privacy Court');
    guard = await x.guardOnDuty(s.c);
    places = await x.places(s.alice);
  }, 120_000);

  afterAll(() => h.close());

  const request = (id: string) =>
    x.inTx(s.c, (tx) =>
      tx.gateServiceRequest.findUniqueOrThrow({ where: { id } }),
    );

  it('erased: the live requests are cancelled by the system; the words and photo go once; security’s note and the emergencies stay', async () => {
    const home = await x.unit(s.c);
    const owner = await x.owner(s.c, home.id);
    const member = await x.family(s.c, home.id, owner);
    const photo = await x.files.ready(member.token, 'gate_service_photo');
    const report = (
      await x
        .http('post', '/security-reports', member.token, {
          unitId: home.id,
          placeId: places.parking.id,
          description: 'PRIVACY-words',
          photoFileId: photo,
        })
        .expect(201)
    ).body as { id: string };
    const lane = (
      await x
        .http('post', '/lane-requests', member.token, {
          unitId: home.id,
          reason: 'moving_truck',
          gateId: guard.gateId,
          notes: 'PRIVACY-notes',
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('post', `/gate/gate-services/${lane.id}/accept`, guard.token, {})
      .expect(200);
    await x
      .http('post', `/gate/gate-services/${report.id}/close`, guard.token, {
        reasonCode: 'not_found',
        note: 'Checked the parking',
      })
      .expect(200);
    const emergency = await x.report(member, home.id, 'medical');

    await eraseNow(h, s.c, member.id);

    expect(await request(lane.id)).toMatchObject({
      status: 'cancelled',
      cancelSide: 'system',
      cancelReason: 'requester_left',
      notes: null,
    });
    const closed = await request(report.id);
    expect(closed).toMatchObject({
      status: 'closed',
      description: null,
      photoFileId: null,
      closeNote: 'Checked the parking',
    });
    expect(closed.textClearedAt).not.toBeNull();
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: photo } }),
    );
    expect(file.deletedAt).not.toBeNull();
    // The emergency stays as it was; security sees the tombstone.
    const staff = (
      await x
        .http('get', `/gate/emergencies/${emergency.id}`, guard.token)
        .expect(200)
    ).body as { status: string; reportedBy: { erased?: true } };
    expect(staff).toMatchObject({
      status: 'reported',
      reportedBy: { id: member.id, erased: true },
    });
    const audit = auditReaders(h);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'gate_service.cancelled',
          targetId: lane.id,
        })
      ).map((r) => r.metadata),
    ).toEqual([
      { from: 'accepted', side: 'system', reasonCode: 'requester_left' },
    ]);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'gate_service.text_cleared',
          targetId: report.id,
        })
      ).map((r) => r.metadata),
    ).toEqual([{ description: true, notes: false, photo: true }]);
    const trail = JSON.stringify(await audit.tenant(s.c.tenantId, {}));
    expect(trail).not.toContain('PRIVACY-');
  });

  it('deactivated: its open requests are cancelled; the words stay until an erasure', async () => {
    const home = await x.unit(s.c);
    const owner = await x.owner(s.c, home.id);
    const member = await x.family(s.c, home.id, owner);
    const walk = (
      await x
        .http('post', '/escort-requests', member.token, {
          unitId: home.id,
          fromPlaceId: places.parking.id,
          toPlaceId: places.phase_a.id,
          when: 'now',
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('patch', `/accounts/${member.id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect((r) => expect(r.status).toBeLessThan(300));
    expect(await request(walk.id)).toMatchObject({
      status: 'cancelled',
      cancelSide: 'system',
    });
  });

  describe('export', () => {
    async function exportOf(p: Who & { email: string }) {
      await stepUp(h, p.token, p.email);
      const asked = await x
        .http('post', '/me/data-exports', p.token, {})
        .expect(201);
      await buildExports(h);
      const dl = await x
        .http(
          'get',
          `/me/data-exports/${(asked.body as { id: string }).id}/download`,
          p.token,
        )
        .expect(200);
      return readArchive((dl.body as { url: string }).url);
    }

    it('its own emergencies and requests; of one it was alerted to, codes and times only; nobody’s name, no staff note', async () => {
      const home = await x.unit(s.c);
      const owner = await x.owner(s.c, home.id);
      const joined = await x.x.joinFamily(s.c, home.id, owner);
      const member = {
        ...(await x.who(s.c, joined.accountId, 'family')),
        email: joined.email,
      };
      const theirs = await x.report(owner, home.id, 'fire');
      await x
        .http('post', `/emergencies/${theirs.id}/on-my-way`, member.token)
        .expect(200);
      await x
        .http('post', `/gate/emergencies/${theirs.id}/accept`, guard.token, {
          etaMinutes: 5,
        })
        .expect(200);
      const mine = await x.report(member, home.id, 'security');
      const report = (
        await x
          .http('post', '/security-reports', member.token, {
            unitId: home.id,
            placeId: places.clubhouse.id,
            description: 'EXPORT-words',
          })
          .expect(201)
      ).body as { id: string; reference: string };
      await x
        .http('post', `/gate/gate-services/${report.id}/close`, guard.token, {
          reasonCode: 'done',
          note: 'EXPORT-staff-note',
        })
        .expect(200);

      const archive = await exportOf(member);
      const emergencies = JSON.parse(
        archive.text('safety/emergencies.json'),
      ) as {
        reported: Record<string, unknown>[];
        alerted: Record<string, unknown>[];
      };
      expect(emergencies.reported).toEqual([
        expect.objectContaining({
          reference: mine.reference,
          type: 'security',
          unitCode: home.code,
          familyNotified: 1,
        }),
      ]);
      expect(emergencies.alerted).toHaveLength(1);
      expect(Object.keys(emergencies.alerted[0]).sort()).toEqual(
        [
          'alertedAt',
          'onMyWayAt',
          'reference',
          'status',
          'type',
          'unitCode',
        ].sort(),
      );
      expect(emergencies.alerted[0]).toMatchObject({
        reference: theirs.reference,
        type: 'fire',
        status: 'on_the_way',
      });
      expect(emergencies.alerted[0].onMyWayAt).not.toBeNull();
      const services = JSON.parse(
        archive.text('safety/gate-services.json'),
      ) as Record<string, unknown>[];
      expect(services).toEqual([
        expect.objectContaining({
          reference: report.reference,
          kind: 'suspicious',
          status: 'closed',
          place: 'Clubhouse',
          description: 'EXPORT-words',
          photo: false,
          closeReason: 'done',
        }),
      ]);
      const text =
        archive.text('safety/emergencies.json') +
        archive.text('safety/gate-services.json');
      for (const id of [owner.id, guard.id]) {
        const name = (
          await x.inTx(s.c, (tx) =>
            tx.account.findUniqueOrThrow({ where: { id } }),
          )
        ).fullName!;
        expect(text).not.toContain(name);
        expect(text).not.toContain(name.split(' ')[0]);
        expect(text).not.toContain(id);
      }
      expect(text).not.toContain('EXPORT-staff-note');
    });
  });
});
