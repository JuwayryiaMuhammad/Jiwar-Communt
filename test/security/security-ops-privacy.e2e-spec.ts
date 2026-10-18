import { auditReaders } from '../setup/audit';
import { day } from '../setup/compound-clock';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

/**
 * ADR 0053, incidents and violations and their privacy. Erased, what the
 * account wrote goes, once each, audited by id: the descriptions of the
 * incidents it reported, the closing notes of those it closed, its
 * internal notes, its violation appeals' words and photo. The records
 * stay, the account shown erased. Its export holds its own incidents,
 * notes and acknowledgements, and the violations of its units with its
 * own appeal's words; nobody else's name or words.
 */
describe('Incidents, violations and privacy', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let placeId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Security Privacy Court');
    placeId = (await x.places(s.alice)).clubhouse.id;
  }, 120_000);

  afterAll(() => h.close());

  const ok = async (
    as: Who,
    path: string,
    body: Record<string, unknown>,
    status = 201,
  ) => {
    const res = await x.http('post', path, as.token, body);
    if (res.status !== status)
      throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string };
  };
  const incident = (
    as: Who,
    path: string,
    description: string,
    over: Record<string, unknown> = {},
  ) =>
    ok(as, path, {
      type: 'hazard',
      severity: 'medium',
      placeId,
      occurredAt: new Date(Date.now() - 600_000).toISOString(),
      description,
      ...over,
    });
  const exportOf = async (who: Who) => {
    const email = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: who.id } }),
      )
    ).email!;
    await stepUp(h, who.token, email);
    const asked = await x
      .http('post', '/me/data-exports', who.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await x
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        who.token,
      )
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  };

  it('erased staff: their reports’ words, their closing notes and their notes go, by id; the incidents stay', async () => {
    const leaving = await x.staff(s.c, ['incidents.manage']);
    const guard = await x.guardOnDuty(s.c);
    const own = await incident(
      leaving,
      '/staff/security/incidents',
      'Leaving words 3391',
    );
    const guards = await incident(
      guard,
      '/gate/incidents',
      'Guard words 7720',
      {
        photoFileIds: [await x.photo(guard, 'incident_photo')],
      },
    );
    await ok(
      leaving,
      `/staff/security/incidents/${guards.id}/notes`,
      { body: 'Leaving note 3391' },
      200,
    );
    for (const id of [own.id, guards.id])
      await ok(
        leaving,
        `/staff/security/incidents/${id}/close`,
        { reasonCode: 'resolved', note: 'Leaving close 3391' },
        200,
      );
    await x
      .http('patch', `/accounts/${leaving.id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    await eraseNow(h, s.c, leaving.id);

    await x.inTx(s.c, async (tx) => {
      expect(
        await tx.incident.findUniqueOrThrow({ where: { id: own.id } }),
      ).toMatchObject({
        description: null,
        textClearedAt: expect.any(Date) as Date,
        closingNote: null,
        closingNoteClearedAt: expect.any(Date) as Date,
        status: 'closed',
        outcome: 'resolved',
        reportedById: leaving.id,
      });
      expect(
        await tx.incident.findUniqueOrThrow({ where: { id: guards.id } }),
      ).toMatchObject({
        description: 'Guard words 7720',
        textClearedAt: null,
        closingNote: null,
      });
      expect(
        await tx.incidentPhoto.count({ where: { incidentId: guards.id } }),
      ).toBe(1);
      expect(
        await tx.incidentNote.findMany({ where: { incidentId: guards.id } }),
      ).toEqual([
        expect.objectContaining({
          authorId: leaving.id,
          body: null,
          textClearedAt: expect.any(Date) as Date,
        }),
      ]);
    });
    const read = auditReaders(h);
    const cleared = async (action: string, targetId: string) =>
      (await read.tenant(s.c.tenantId, { action, targetId })).map(
        (r) => r.metadata,
      );
    expect(await cleared('incident.text_cleared', own.id)).toEqual([
      { description: true, closingNote: true },
    ]);
    expect(await cleared('incident.text_cleared', guards.id)).toEqual([
      { description: false, closingNote: true },
    ]);
    const [noteRow] = await x.inTx(s.c, (tx) =>
      tx.incidentNote.findMany({ where: { incidentId: guards.id } }),
    );
    expect(await cleared('incident_note.text_cleared', noteRow.id)).toEqual([
      { incidentId: guards.id },
    ]);
    const detail = (
      await x
        .http('get', `/staff/security/incidents/${own.id}`, s.manager.token)
        .expect(200)
    ).body as {
      description: string | null;
      closingNote: string | null;
      reportedBy: unknown;
    };
    expect(detail).toMatchObject({ description: null, closingNote: null });
    expect(detail.reportedBy).toEqual({ id: leaving.id, erased: true });
  });

  it('an erased appellant: the appeal’s words and photo go, by id; the violation stays and is still decided', async () => {
    const unit = await x.unit(s.c, 'P7');
    const primary = await x.owner(s.c, unit.id);
    const owner = await x.family(s.c, unit.id, primary);
    const v = await ok(s.manager, '/staff/violations', {
      kind: 'noise',
      unitCode: unit.code,
      occurredOn: day(0),
      amount: '60',
    });
    const photo = await x.photo(owner, 'violation_appeal_photo');
    await ok(
      owner,
      `/violations/${v.id}/appeal`,
      { reason: 'Appeal words 5108', photoFileId: photo },
      200,
    );
    await eraseNow(h, s.c, owner.id);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.unitViolation.findUniqueOrThrow({ where: { id: v.id } }),
      ),
    ).toMatchObject({
      status: 'under_appeal',
      appealText: null,
      appealPhotoFileId: null,
      appealClearedAt: expect.any(Date) as Date,
      appealedById: owner.id,
    });
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findUnique({ where: { id: photo } }),
    );
    expect(file === null || file.deletedAt !== null).toBe(true);
    expect(
      (
        await auditReaders(h).tenant(s.c.tenantId, {
          action: 'violation.appeal_cleared',
          targetId: v.id,
        })
      ).map((r) => r.metadata),
    ).toEqual([{ unitId: unit.id, photo: true }]);
    await ok(
      s.manager,
      `/staff/violations/${v.id}/decide-appeal`,
      { decision: 'upheld' },
      200,
    );
  });

  it('a guard’s export: the incidents they reported with their words, their acknowledgements; never the internal notes or the closing note', async () => {
    const guard = await x.guardOnDuty(s.c);
    const i = await incident(guard, '/gate/incidents', 'My own words 8812');
    await ok(guard, `/gate/incidents/${i.id}/acknowledge`, {}, 200);
    await ok(
      s.manager,
      `/staff/security/incidents/${i.id}/notes`,
      { body: 'Internal words 8812' },
      200,
    );
    await ok(
      s.manager,
      `/staff/security/incidents/${i.id}/close`,
      { reasonCode: 'resolved', note: 'Closing words 8812' },
      200,
    );
    const archive = await exportOf(guard);
    expect(JSON.parse(archive.text('incidents/reported.json'))).toEqual([
      expect.objectContaining({
        reference: expect.stringMatching(/^I-\d{4}$/) as string,
        type: 'hazard',
        description: 'My own words 8812',
        status: 'closed',
        outcome: 'resolved',
      }),
    ]);
    expect(JSON.parse(archive.text('incidents/notes.json'))).toEqual([]);
    expect(JSON.parse(archive.text('incidents/acknowledgements.json'))).toEqual(
      [expect.objectContaining({ role: 'author' })],
    );
    expect(archive.all).not.toContain('Internal words 8812');
    expect(archive.all).not.toContain('Closing words 8812');
    const manager = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: s.manager.id } }),
      )
    ).fullName!;
    expect(archive.all).not.toContain(manager);
  });

  it('a resident’s export: the unit’s violations, their own appeal’s words, the payments; never who issued one; no incidents', async () => {
    const guard = await x.guardOnDuty(s.c);
    const v = await ok(guard, '/gate/violations', {
      kind: 'pets',
      unitCode: s.home.code,
      occurredOn: day(0),
      note: 'Issued note 6630',
    });
    await ok(
      s.alice,
      `/violations/${v.id}/appeal`,
      { reason: 'Alice appeal 6630' },
      200,
    );
    const archive = await exportOf(s.alice);
    const rows = JSON.parse(archive.text('violations/violations.json')) as {
      reference: string;
      note: string | null;
      appeal: { reason: string | null } | null;
    }[];
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reference: expect.stringMatching(/^V-\d{4}$/) as string,
          kind: 'pets',
          note: 'Issued note 6630',
          status: 'under_appeal',
          appeal: expect.objectContaining({
            reason: 'Alice appeal 6630',
          }) as object,
        }),
      ]),
    );
    expect(archive.all).not.toContain(guard.id);
    for (const name of ['reported', 'notes', 'acknowledgements'])
      expect(JSON.parse(archive.text(`incidents/${name}.json`))).toEqual([]);
  });
});
