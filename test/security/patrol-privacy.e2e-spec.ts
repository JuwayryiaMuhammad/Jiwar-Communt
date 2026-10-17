import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type RouteBody, type Who } from '../setup/patrols';

/**
 * ADR 0052, a guard's patrols and their privacy: erased, their notes'
 * words go and where they walked is deleted, both audited; their runs,
 * scans and the notes' photos stay, the guard shown erased. Their export
 * holds their own runs, scans, notes and track, nobody else's.
 */
describe('Patrols and privacy', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;
  let qr: string;
  let route: RouteBody;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Patrol Privacy Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
    const point = await x.checkpoint(supervisor, { gateId });
    const other = await x.checkpoint(supervisor, { gateId });
    qr = point.qrPayload;
    route = await x.route(supervisor, { gateId }, [point.id, other.id]);
  }, 120_000);

  afterAll(() => h.close());

  /** A guard's run with a scan, a note with a photo, and two points. */
  async function walked(guard: Who, words: string) {
    await x.start(guard, { gateId });
    const run = await x.adhoc(guard, route.id);
    const scan = (
      await x
        .scanRaw(guard, run.id, { method: 'qr', payload: qr, lat: 30, lng: 31 })
        .expect(201)
    ).body as { id: string };
    const photo = await x.files.ready(guard.token, 'patrol_photo');
    const note = (
      await x
        .noteRaw(guard, run.id, {
          scanId: scan.id,
          outcome: 'issue_found',
          text: words,
          photoFileIds: [photo],
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('post', `/gate/patrols/runs/${run.id}/track`, guard.token, {
        points: [
          {
            recordedAt: new Date(Date.now() - 1000).toISOString(),
            lat: 30,
            lng: 31,
          },
          { recordedAt: new Date().toISOString(), lat: 30.001, lng: 31 },
        ],
      })
      .expect(200);
    await x.endRaw(guard).expect(200);
    return { run, scan, note };
  }

  it('erased: the notes’ words go and the track is deleted, audited; runs, scans and photos stay', async () => {
    const leaving = await x.guard(s.c);
    const { run, scan, note } = await walked(
      leaving,
      'Saw Mr Adel at the fence',
    );
    await x
      .http('patch', `/accounts/${leaving.id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    await eraseNow(h, s.c, leaving.id);

    await x.inTx(s.c, async (tx) => {
      expect(
        await tx.patrolNote.findUniqueOrThrow({ where: { id: note.id } }),
      ).toMatchObject({
        text: null,
        textClearedAt: expect.any(Date) as Date,
        outcome: 'issue_found',
      });
      expect(
        await tx.patrolNotePhoto.count({ where: { noteId: note.id } }),
      ).toBe(1);
      expect(
        await tx.patrolTrackPoint.count({
          where: { guardAccountId: leaving.id },
        }),
      ).toBe(0);
      expect(
        await tx.patrolScan.findUniqueOrThrow({ where: { id: scan.id } }),
      ).toMatchObject({ lat: 30, lng: 31 });
    });
    const read = auditReaders(h);
    expect(
      await read.tenant(s.c.tenantId, {
        action: 'patrol_note.text_cleared',
        targetId: note.id,
      }),
    ).toHaveLength(1);
    const erased = await read.tenant(s.c.tenantId, {
      action: 'patrol_track.erased',
      targetId: leaving.id,
    });
    expect(erased.map((r) => r.metadata)).toEqual([{ points: 2 }]);
    const detail = (
      await x
        .http('get', `/staff/security/patrols/runs/${run.id}`, supervisor.token)
        .expect(200)
    ).body as {
      guard: unknown;
      stops: {
        note: {
          text: string | null;
          textCleared: boolean;
          photos: unknown[];
        } | null;
      }[];
    };
    expect(detail.guard).toEqual({ id: leaving.id, erased: true });
    expect(detail.stops[0].note).toMatchObject({
      text: null,
      textCleared: true,
    });
    expect(detail.stops[0].note!.photos).toHaveLength(1);
  });

  it('a guard’s export holds their own runs, scans, notes and track; no other guard’s name or words', async () => {
    const guard = await x.guard(s.c);
    const other = await x.guard(s.c);
    await walked(other, 'Other words 4417');
    await walked(guard, 'My words at the gate');
    const email = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: guard.id } }),
      )
    ).email!;
    const otherName = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: other.id } }),
      )
    ).fullName!;
    await stepUp(h, guard.token, email);
    const asked = await x
      .http('post', '/me/data-exports', guard.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await x
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        guard.token,
      )
      .expect(200);
    const archive = await readArchive((dl.body as { url: string }).url);
    const runs = JSON.parse(archive.text('patrols/runs.json')) as {
      route: string;
      status: string;
    }[];
    expect(runs).toEqual([
      expect.objectContaining({ route: route.nameEn, status: 'incomplete' }),
    ]);
    const scans = JSON.parse(archive.text('patrols/scans.json')) as unknown[];
    expect(scans).toHaveLength(1);
    const notes = JSON.parse(archive.text('patrols/notes.json')) as {
      text: string;
      photos: number;
    }[];
    expect(notes).toEqual([
      expect.objectContaining({ text: 'My words at the gate', photos: 1 }),
    ]);
    const track = JSON.parse(archive.text('patrols/track.json')) as unknown[];
    expect(track).toHaveLength(2);
    expect(archive.all).not.toContain(otherName);
    expect(archive.all).not.toContain('Other words 4417');
  });
});
