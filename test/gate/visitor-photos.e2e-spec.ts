import { auditReaders } from '../setup/audit';
import { dbClock } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';

/**
 * ADR 0056, the visitor's photo at entry: optional, taken by the guard at a
 * visitor's `in`; seen by the guards on shift and the management only,
 * never the household, a notification or the audit; deleted 30 days after
 * the entry unless an incident keeps it, for as long as the incident.
 */
describe('Gate — the visitor’s photo at entry (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Visitor Photos Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  /** A visitor let in on their pass with the guard's photo: entry and file. */
  async function photographed() {
    const p = await g.pass(s.alice, s.home.id);
    const fileId = await g.photo(s.guard, 'visitor_photo');
    const entryId = await g.enter(s.guard, 'visitor_pass', p.id, {
      photoFileId: fileId,
    });
    return { passId: p.id, fileId, entryId };
  }
  const photoRaw = (as: { token: string }, entryId: string) =>
    g.http('get', `/gate/entries/${entryId}/photo`, as.token);

  it('taken at a visitor’s entry: the guard on shift and the management see it, the household never', async () => {
    const since = new Date(dbClock().getTime() - 60_000);
    const { entryId, fileId } = await photographed();
    const inside = (
      await g.http('get', '/gate/inside', s.guard.token).expect(200)
    ).body as { data: { photo: { url: string } | null }[] };
    expect(inside.data.some((i) => i.photo?.url)).toBe(true);
    const log = (
      await g.http('get', '/gate/entries', s.manager.token).expect(200)
    ).body as { data: { id: string; hasPhoto: boolean }[] };
    expect(log.data.find((e) => e.id === entryId)?.hasPhoto).toBe(true);
    for (const reader of [s.manager, s.guard])
      expect((await photoRaw(reader, entryId).expect(200)).body).toMatchObject({
        url: expect.any(String) as string,
        expiresAt: expect.any(String) as string,
      });
    await photoRaw(s.alice, entryId).expect(403);
    // Off shift, a guard sees nothing.
    expect(code(await photoRaw(await g.guard(s.c), entryId).expect(403))).toBe(
      'NO_OPEN_SHIFT',
    );
    // Never in a notification or the audit (but the upload's own rows,
    // which name their file as every upload's do).
    const rows = await g.inTx(s.c, async (tx) => ({
      audit: await tx.auditLog.findMany({
        where: { occurredAt: { gte: since }, NOT: { targetType: 'file' } },
      }),
      notifications: await tx.notification.findMany({
        where: { createdAt: { gte: since } },
      }),
    }));
    expect(JSON.stringify(rows)).not.toContain(fileId);
  });

  it('a visitor’s `in` only, the guard’s own upload', async () => {
    const p = await g.pass(s.alice, s.home.id, { partySize: 2 });
    await g.enter(s.guard, 'visitor_pass', p.id);
    const onExit = await g.entryRaw(s.guard, 'visitor_pass', p.id, {
      direction: 'out',
      photoFileId: await g.photo(s.guard, 'visitor_photo'),
    });
    expect(fields(onExit)).toEqual([
      { field: 'photoFileId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const w = await g.worker(s.c, s.alice, s.home.id, 'inside');
    const onWorker = await g.entryRaw(
      s.guard,
      'worker_engagement',
      w.engagementId,
      {
        photoFileId: await g.photo(s.guard, 'visitor_photo'),
      },
    );
    expect(fields(onWorker)).toEqual([
      { field: 'photoFileId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    const another = await g.guardAt(s.c, s.guard.gateId);
    const theirs = await g.entryRaw(s.guard, 'visitor_pass', p.id, {
      photoFileId: await g.photo(another, 'visitor_photo'),
    });
    expect(fields(theirs)).toEqual([
      { field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
  });

  it('deleted 30 days after the entry: the row, then the file', async () => {
    const { entryId, fileId } = await photographed();
    await g.photoDue(entryId);
    await g.sweepPhotos();
    expect(code(await photoRaw(s.manager, entryId).expect(404))).toBe(
      'ENTRY_PHOTO_NOT_FOUND',
    );
    const file = await g.inTx(s.c, (tx) =>
      tx.storedFile.findUnique({ where: { id: fileId } }),
    );
    expect(file?.deletedAt ?? null).not.toBeNull();
    const [deleted] = await read.tenant(s.c.tenantId, {
      action: 'file.deleted',
      targetId: fileId,
    });
    expect(deleted.metadata).toMatchObject({ reasonCode: 'retention' });
  });

  describe('kept by an incident', () => {
    it('the reporting guard keeps it past its 30 days, for as long as the incident', async () => {
      const { entryId } = await photographed();
      const incidentId = await g.incident(s.guard, s.unitCode);
      const linked = await g
        .http('post', `/gate/incidents/${incidentId}/evidence`, s.guard.token, {
          kind: 'visitor_photo',
          entryId,
        })
        .expect(201);
      expect(linked.body).toMatchObject({
        kind: 'visitor_photo',
        entryId,
        linkedBy: { id: s.guard.id },
        photo: { url: expect.any(String) as string },
      });
      await g.photoDue(entryId);
      await g.sweepPhotos();
      await photoRaw(s.manager, entryId).expect(200);
      const kept = (
        await g
          .http(
            'get',
            `/staff/security/incidents/${incidentId}/evidence`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: { entryId: string }[] };
      expect(kept.data.map((e) => e.entryId)).toEqual([entryId]);
      const [audit] = await read.tenant(s.c.tenantId, {
        action: 'incident.evidence_linked',
        targetId: incidentId,
      });
      expect(audit.metadata).toEqual({
        evidenceId: (linked.body as { id: string }).id,
        kind: 'visitor_photo',
        entryId,
      });
      expect(leakText(audit)).not.toContain('forced');
    });

    it('once each; never on a closed incident, nor another guard’s; never a photo that is gone', async () => {
      const { entryId } = await photographed();
      const incidentId = await g.incident(s.guard, s.unitCode);
      const link = (as: { token: string }, path: string, entry = entryId) =>
        g.http('post', path, as.token, {
          kind: 'visitor_photo',
          entryId: entry,
        });
      const gatePath = `/gate/incidents/${incidentId}/evidence`;
      const staffPath = `/staff/security/incidents/${incidentId}/evidence`;
      await link(s.manager, staffPath).expect(201);
      expect(code(await link(s.guard, gatePath).expect(409))).toBe(
        'INCIDENT_EVIDENCE_EXISTS',
      );
      const other = await g.guardAt(s.c, s.guard.gateId);
      expect(code(await link(other, gatePath).expect(404))).toBe(
        'INCIDENT_NOT_FOUND',
      );
      const gone = await photographed();
      await g.photoDue(gone.entryId);
      await g.sweepPhotos();
      expect(
        code(await link(s.manager, staffPath, gone.entryId).expect(404)),
      ).toBe('ENTRY_PHOTO_NOT_FOUND');
      await g
        .http(
          'post',
          `/staff/security/incidents/${incidentId}/close`,
          s.manager.token,
          { reasonCode: 'resolved', note: 'Door fixed' },
        )
        .expect(200);
      const late = await photographed();
      expect(
        code(await link(s.manager, staffPath, late.entryId).expect(409)),
      ).toBe('INCIDENT_CLOSED');
    });
  });
});
