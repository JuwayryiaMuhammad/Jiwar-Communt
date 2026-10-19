import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { entryAction, offlineHelpers } from '../setup/offline';

interface BatchBody {
  id: string;
  status: 'accepted' | 'quarantined';
  pendingReview: boolean;
  reviewedAt: string | null;
  reviewedBy: { id: string } | null;
  reviewDecision: 'accepted' | 'rejected' | null;
  actions: {
    clientId: string;
    seq: number;
    status: string;
    reason: string | null;
    occurredAt: string | null;
    entryId: string | null;
    subject: { type: string; id: string } | null;
    direction: string | null;
  }[];
}

/**
 * ADR 0057, a revoked device's uploads quarantined, never discarded: kept
 * as sent, nothing recorded, one security flag per batch, the keepers told;
 * the management accepts the batch (each action decided as at its receipt)
 * or rejects it (each kept, rejected), once.
 */
describe('Gate offline — a revoked device’s quarantine (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Quarantine Court');
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const onPass = (id: string) => ({ type: 'visitor_pass', id });
  const passRow = (id: string) =>
    o.inTx(s.c, (tx) => tx.visitorPass.findUniqueOrThrow({ where: { id } }));
  const batch = async (id: string) =>
    (
      await o
        .http('get', `/staff/gate/offline/batches/${id}`, s.manager.token)
        .expect(200)
    ).body as BatchBody;
  const reviewRaw = (
    id: string,
    decision: string,
    headers: Record<string, string> = {},
  ) =>
    o.http(
      'post',
      `/staff/gate/offline/batches/${id}/review`,
      s.manager.token,
      { decision },
      headers,
    );

  /** A device with its bundle, revoked, that then uploads `actions`. */
  async function quarantined(count = 2) {
    const p = await o.passFull(s.alice, s.home.id, { partySize: 3 });
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    await o.revokeRaw(s.manager, d.id, 'stolen').expect(200);
    const actions = Array.from({ length: count }, () =>
      entryAction(d, b, onPass(p.id)),
    );
    const up = await o.upload(s.guard, s.c, d, actions);
    return { p, d, b, actions, up };
  }

  it('kept as sent, nothing recorded, one security flag, the keepers told', async () => {
    const { p, d, actions, up } = await quarantined();
    expect(up.results).toEqual(
      actions.map((a) => ({
        clientId: a.clientId,
        seq: a.seq,
        status: 'quarantined',
        reason: null,
        flags: [],
        entryId: null,
      })),
    );
    expect(up.ackedThroughSeq).toBe(2);
    expect((await passRow(p.id)).entriesUsed).toBe(0);
    expect(
      await o.inTx(s.c, (tx) =>
        tx.gateEntry.count({ where: { subjectId: p.id } }),
      ),
    ).toBe(0);
    expect((await o.flagsOf(s.c, d.id)).map((f) => f.kind)).toEqual([
      'device_revoked_upload',
    ]);
    expect(await o.told(s.c, s.manager.id, up.batchId)).toEqual([
      { kind: 'gate_offline.security_conflict', params: { flags: 1 } },
    ]);
    const view = await batch(up.batchId);
    expect(view).toMatchObject({
      status: 'quarantined',
      pendingReview: true,
      reviewedAt: null,
    });
    expect(view.actions).toEqual(
      actions.map((a): unknown =>
        expect.objectContaining({
          clientId: a.clientId,
          status: 'quarantined',
          subject: { type: 'visitor_pass', id: p.id },
          direction: 'in',
          entryId: null,
        }),
      ),
    );
    // The management's queue holds it.
    const pending = (
      await o
        .http(
          'get',
          `/staff/gate/offline/batches?status=pending&deviceId=${d.id}`,
          s.manager.token,
        )
        .expect(200)
    ).body as { data: BatchBody[] };
    expect(pending.data.map((x) => x.id)).toEqual([up.batchId]);
  });

  it('a retry of the batch answers the same; another batch, another flag', async () => {
    const { d, b, actions, up } = await quarantined(1);
    const again = await o.upload(s.guard, s.c, d, actions, {
      batchId: up.batchId,
    });
    expect(again.results[0].status).toBe('duplicate');
    await o.upload(s.guard, s.c, d, [entryAction(d, b, onPass(newId()))]);
    expect(
      (await o.flagsOf(s.c, d.id)).filter(
        (f) => f.kind === 'device_revoked_upload',
      ),
    ).toHaveLength(2);
  });

  it('accepted: each action decided as at its receipt, at its device time, once', async () => {
    const { p, b, actions, up } = await quarantined();
    const key = { 'Idempotency-Key': `batch-review-${up.batchId}` };
    const res = await reviewRaw(up.batchId, 'accept', key).expect(200);
    const view = res.body as BatchBody;
    expect(view).toMatchObject({
      pendingReview: false,
      reviewDecision: 'accepted',
      reviewedBy: { id: s.manager.id },
    });
    expect(view.actions.map((a) => [a.status, a.entryId])).toEqual(
      actions.map((a) => ['recorded', a.clientId]),
    );
    const entries = await o.inTx(s.c, (tx) =>
      tx.gateEntry.findMany({ where: { subjectId: p.id } }),
    );
    expect(entries.map((e) => e.occurredAt)).toEqual([
      new Date(b.issuedAt),
      new Date(b.issuedAt),
    ]);
    expect((await passRow(p.id)).entriesUsed).toBe(2);
    const replay = await reviewRaw(up.batchId, 'accept', key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    const again = await reviewRaw(up.batchId, 'reject');
    expect([again.status, code(again)]).toEqual([
      409,
      'GATE_OFFLINE_BATCH_REVIEWED',
    ]);
    expect(
      await read.tenant(s.c.tenantId, {
        action: 'gate_offline_batch.reviewed',
        targetId: up.batchId,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: { decision: 'accepted', actions: 2, recorded: 2 },
      }),
    ]);
  });

  it('accepted, what cannot have happened is still rejected', async () => {
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    await o.revokeRaw(s.manager, d.id).expect(200);
    const up = await o.upload(s.guard, s.c, d, [
      entryAction(d, b, onPass(newId())),
    ]);
    const view = (await reviewRaw(up.batchId, 'accept').expect(200))
      .body as BatchBody;
    expect(view.actions.map((a) => [a.status, a.reason])).toEqual([
      ['rejected', 'subject_unknown'],
    ]);
  });

  it('rejected: each kept, rejected; nothing recorded', async () => {
    const { p, up } = await quarantined();
    const view = (await reviewRaw(up.batchId, 'reject').expect(200))
      .body as BatchBody;
    expect(view.actions.map((a) => [a.status, a.reason])).toEqual([
      ['rejected', 'quarantine_rejected'],
      ['rejected', 'quarantine_rejected'],
    ]);
    expect((await passRow(p.id)).entriesUsed).toBe(0);
    const rows = await o.inTx(s.c, (tx) =>
      tx.gateOfflineAction.findMany({ where: { batchId: up.batchId } }),
    );
    expect(rows.every((r) => r.body === null && r.reviewedAt !== null)).toBe(
      true,
    );
  });

  it('a batch with nothing quarantined: GATE_OFFLINE_BATCH_NOT_QUARANTINED', async () => {
    const p = await o.passFull(s.alice, s.home.id);
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    const up = await o.upload(s.guard, s.c, d, [
      entryAction(d, b, onPass(p.id)),
    ]);
    const res = await reviewRaw(up.batchId, 'accept');
    expect([res.status, code(res)]).toEqual([
      409,
      'GATE_OFFLINE_BATCH_NOT_QUARANTINED',
    ]);
  });
});
