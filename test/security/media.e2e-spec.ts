import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  bogusBoxSize,
  fastStart,
  moovAtEnd,
  noMovieHeader,
  truncated,
} from '../../src/core/files/mp4-duration.fixtures';
import { patrolHelpers, type RouteBody, type Who } from '../setup/patrols';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

interface MediaBody {
  kind: string;
  durationMs: number;
  url: string;
  expiresAt: string;
}

/**
 * ADR 0056, recordings: a patrol note's or an incident's sound or video,
 * the MP4 family only. Finalize reads the length from the container — its
 * `moov` at the start or the end, never the media — and refuses one it
 * cannot read, or with no movie header, deleting it. Attaching checks the
 * gate's seconds and megabytes. Real containers go through the store.
 */
describe('Recordings on patrol notes and incidents (ADR 0056)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let supervisor: Who;
  let route: RouteBody;
  let qrPayload: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Recordings Court');
    guard = await x.guardOnDuty(s.c);
    supervisor = await x.supervisor(s.c);
    const point = await x.checkpoint(supervisor, { gateId: guard.gateId });
    qrPayload = point.qrPayload!;
    route = await x.route(supervisor, { gateId: guard.gateId }, [point.id]);
  }, 180_000);

  afterAll(() => h.close());

  /** Declares, uploads and finalizes `bytes`: the finalize's answer. */
  async function finalized(
    as: Who,
    purpose: string,
    type: string,
    bytes: Buffer,
  ) {
    const id = await x.files.uploaded(as.token, purpose, type, bytes);
    return { id, res: await x.files.finalize(as.token, id) };
  }
  async function recording(
    as: Who,
    purpose: string,
    type: string,
    bytes: Buffer,
  ): Promise<string> {
    const { id, res } = await finalized(as, purpose, type, bytes);
    if (res.status !== 200)
      throw new Error(`finalize: ${res.status} ${JSON.stringify(res.body)}`);
    return id;
  }
  const fileRow = (id: string) =>
    x.inTx(s.c, (tx) => tx.storedFile.findUnique({ where: { id } }));
  const report = (as: Who, body: Record<string, unknown>) =>
    x.http('post', '/gate/incidents', as.token, {
      type: 'hazard',
      severity: 'medium',
      unitCode: s.home.code,
      occurredAt: new Date(dbClock().getTime() - 600_000).toISOString(),
      description: 'Shouting by the pool',
      ...body,
    });
  const settings = (body: Record<string, number>) =>
    x.http('patch', '/staff/gate/settings', s.manager.token, body).expect(200);

  describe('finalize reads the length from the container', () => {
    it('fast start, moov at the end, QuickTime: each its length', async () => {
      const cases = [
        [
          'incident_audio',
          'audio/mp4',
          fastStart({ seconds: 4.2, brand: 'M4A ' }),
          4200,
        ],
        [
          'incident_video',
          'video/mp4',
          moovAtEnd({ seconds: 9, mediaBytes: 200_000 }),
          9000,
        ],
        [
          'patrol_note_video',
          'video/quicktime',
          moovAtEnd({ seconds: 1.5, brand: 'qt  ', version: 1 }),
          1500,
        ],
      ] as const;
      for (const [purpose, type, bytes, ms] of cases) {
        const { id, res } = await finalized(guard, purpose, type, bytes);
        expect(res.status).toBe(200);
        expect((res.body as { durationMs: number }).durationMs).toBe(ms);
        expect(await fileRow(id)).toMatchObject({
          status: 'ready',
          mediaDurationMs: ms,
        });
      }
    });

    it('truncated, or with a bogus box size: refused as unreadable, and gone', async () => {
      for (const bytes of [
        truncated({ seconds: 5 }),
        bogusBoxSize({ seconds: 5 }),
      ]) {
        const { id, res } = await finalized(
          guard,
          'incident_video',
          'video/mp4',
          bytes,
        );
        expect(code(res)).toEqual({
          status: 422,
          code: 'FILE_MEDIA_UNREADABLE',
        });
        expect((res.body as { params: unknown }).params).toEqual({
          reason: 'box_out_of_bounds',
        });
        const row = await fileRow(id);
        expect(row === null || row.deletedAt !== null).toBe(true);
      }
    });

    it('no movie header: refused as such, and gone', async () => {
      const { id, res } = await finalized(
        guard,
        'incident_audio',
        'audio/mp4',
        noMovieHeader(),
      );
      expect(code(res)).toEqual({
        status: 422,
        code: 'FILE_MEDIA_NO_DURATION',
      });
      const row = await fileRow(id);
      expect(row === null || row.deletedAt !== null).toBe(true);
    });

    it('the MP4 family only, as declared, within the system’s caps', async () => {
      // An image declared as a recording.
      const disguised = await finalized(
        guard,
        'incident_video',
        'video/mp4',
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(64),
        ]),
      );
      expect(code(disguised.res)).toEqual({
        status: 422,
        code: 'FILE_CONTENT_MISMATCH',
      });
      // QuickTime declared as MP4.
      const quickTime = await finalized(
        guard,
        'incident_video',
        'video/mp4',
        fastStart({ seconds: 2, brand: 'qt  ' }),
      );
      expect(code(quickTime.res)).toEqual({
        status: 422,
        code: 'FILE_CONTENT_MISMATCH',
      });
      const declare = (purpose: string, contentType: string, size: number) =>
        x.http('post', '/files/uploads', guard.token, {
          purpose,
          contentType,
          size,
        });
      expect(
        fields(await declare('incident_audio', 'video/mp4', 1000).expect(400)),
      ).toEqual([
        {
          field: 'contentType',
          code: 'FILE_TYPE_NOT_ALLOWED',
          params: { allowed: ['audio/mp4'] },
        },
      ]);
      expect(
        fields(await declare('incident_photo', 'video/mp4', 1000).expect(400)),
      ).toEqual([expect.objectContaining({ code: 'FILE_TYPE_NOT_ALLOWED' })]);
      expect(
        fields(
          await declare(
            'patrol_note_audio',
            'audio/mp4',
            20 * 1024 * 1024 + 1,
          ).expect(400),
        ),
      ).toEqual([
        {
          field: 'size',
          code: 'FILE_TOO_LARGE',
          params: { maxBytes: 20 * 1024 * 1024 },
        },
      ]);
    });
  });

  describe('an incident takes its recordings at its report', () => {
    it('its readers see each with its kind and length; the audit counts them', async () => {
      const audio = await recording(
        guard,
        'incident_audio',
        'audio/mp4',
        fastStart({ seconds: 3 }),
      );
      const video = await recording(
        guard,
        'incident_video',
        'video/mp4',
        moovAtEnd({ seconds: 6 }),
      );
      const res = await report(guard, { mediaFileIds: [audio, video] }).expect(
        201,
      );
      const incident = res.body as { id: string; media: MediaBody[] };
      expect(incident.media.map((m) => [m.kind, m.durationMs])).toEqual([
        ['audio', 3000],
        ['video', 6000],
      ]);
      expect(incident.media[0].url).toMatch(/^https?:\/\//);
      const staff = (
        await x
          .http(
            'get',
            `/staff/security/incidents/${incident.id}`,
            supervisor.token,
          )
          .expect(200)
      ).body as { media: MediaBody[] };
      expect(staff.media).toHaveLength(2);
      // Attached: no longer the guard's to read or delete.
      expect(code(await x.http('get', `/files/${audio}`, guard.token))).toEqual(
        { status: 404, code: 'FILE_NOT_FOUND' },
      );
      const [audit] = await auditReaders(h).tenant(s.c.tenantId, {
        action: 'incident.reported',
        targetId: incident.id,
      });
      expect(audit.metadata).toMatchObject({ photos: 0, media: 2 });
    });

    it('another record’s recording, or none of the caller’s: not available', async () => {
      const noteAudio = await recording(
        guard,
        'patrol_note_audio',
        'audio/mp4',
        fastStart({ seconds: 2 }),
      );
      expect(
        fields(await report(guard, { mediaFileIds: [noteAudio] }).expect(400)),
      ).toEqual([{ field: 'mediaFileIds', code: 'FILE_NOT_AVAILABLE' }]);
      const theirs = await recording(
        supervisor,
        'incident_audio',
        'audio/mp4',
        fastStart({ seconds: 2 }),
      );
      expect(
        fields(await report(guard, { mediaFileIds: [theirs] }).expect(400)),
      ).toEqual([{ field: 'mediaFileIds', code: 'FILE_NOT_AVAILABLE' }]);
    });

    it('within the gate’s seconds and megabytes; refused, nothing is attached', async () => {
      const long = await recording(
        guard,
        'incident_audio',
        'audio/mp4',
        fastStart({ seconds: 12 }),
      );
      const large = await recording(
        guard,
        'incident_video',
        'video/mp4',
        fastStart({ seconds: 2, mediaBytes: 1_200_000 }),
      );
      await settings({ audioMaxSeconds: 10, videoMaxMb: 1 });
      try {
        expect(
          fields(await report(guard, { mediaFileIds: [long] }).expect(400)),
        ).toEqual([
          {
            field: 'mediaFileIds',
            code: 'MEDIA_TOO_LONG',
            params: { maxSeconds: 10 },
          },
        ]);
        expect(
          fields(await report(guard, { mediaFileIds: [large] }).expect(400)),
        ).toEqual([
          {
            field: 'mediaFileIds',
            code: 'FILE_TOO_LARGE',
            params: { maxBytes: 1024 * 1024 },
          },
        ]);
        // Still the guard's, unattached.
        for (const id of [long, large])
          expect(await fileRow(id)).toMatchObject({
            ownerAccountId: guard.id,
            attachedAt: null,
          });
      } finally {
        await settings({ audioMaxSeconds: 300, videoMaxMb: 100 });
      }
      await report(guard, { mediaFileIds: [long, large] }).expect(201);
    });

    it('three at most', async () => {
      const ids = [];
      for (let i = 0; i < 4; i++)
        ids.push(
          await recording(
            guard,
            'incident_audio',
            'audio/mp4',
            fastStart({ seconds: 1 }),
          ),
        );
      expect(code(await report(guard, { mediaFileIds: ids }))).toEqual({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    });
  });

  it('a patrol note takes its recordings; its author and the management hear them, a colleague does not', async () => {
    const walker = await x.guard(s.c);
    await x.start(walker, { gateId: guard.gateId });
    const run = await x.adhoc(walker, route.id);
    const scan = (
      await x
        .scanRaw(walker, run.id, { method: 'qr', payload: qrPayload })
        .expect(201)
    ).body as { id: string };
    const audio = await recording(
      walker,
      'patrol_note_audio',
      'audio/mp4',
      moovAtEnd({ seconds: 5 }),
    );
    const note = await x
      .noteRaw(walker, run.id, {
        scanId: scan.id,
        outcome: 'issue_found',
        text: 'Listen to the pump',
        mediaFileIds: [audio],
      })
      .expect(201);
    expect(note.body).toMatchObject({ photos: 0, media: 1 });
    const staff = (
      await x
        .http('get', `/staff/security/patrols/runs/${run.id}`, supervisor.token)
        .expect(200)
    ).body as {
      status: string;
      stops: { note: { media: MediaBody[] } | null }[];
    };
    // Its one checkpoint scanned, the run ended itself.
    expect(staff.status).toBe('completed');
    expect(
      staff.stops[0].note!.media.map((m) => [m.kind, m.durationMs]),
    ).toEqual([['audio', 5000]]);
    const mine = (
      await x
        .http('get', `/gate/patrols/runs/${run.id}`, walker.token)
        .expect(200)
    ).body as { stops: { note: { media?: MediaBody[] } | null }[] };
    expect(mine.stops[0].note!.media).toHaveLength(1);
    const colleague = await x.guard(s.c);
    await x.start(colleague, { gateId: guard.gateId });
    const theirs = (
      await x
        .http('get', `/gate/patrols/runs/${run.id}`, colleague.token)
        .expect(200)
    ).body as { stops: { note: Record<string, unknown> | null }[] };
    expect(theirs.stops[0].note).not.toHaveProperty('media');
  });
});
