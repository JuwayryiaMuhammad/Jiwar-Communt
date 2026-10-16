import { createHash } from 'node:crypto';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { patrolHelpers, type CheckpointBody, type Who } from '../setup/patrols';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

/**
 * ADR 0052: the checkpoints a patrol scans. `patrols.manage` adds them at
 * a gate or a zone, with a position or none; the QR payload is answered
 * once, and only its token's hash is kept. A reissue prints a new one and
 * the old one stops scanning; a checkpoint is retired once, never deleted.
 */
describe('Patrol checkpoints', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof patrolHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof patrolHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = patrolHelpers(h);
    s = await x.setUp('Checkpoint Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const list = async (as: Who, query = '') =>
    (
      await x
        .http('get', `/staff/security/patrols/checkpoints${query}`, as.token)
        .expect(200)
    ).body as { data: CheckpointBody[]; nextCursor: string | null };

  it('added at a gate with its payload, once; only the hash of its token is kept, and no list shows it', async () => {
    const made = await x.checkpoint(
      supervisor,
      { gateId },
      { position: { lat: 30.0444, lng: 31.2357 } },
    );
    expect(made.post.gateId).toBe(gateId);
    expect(made.position).toEqual({ lat: 30.0444, lng: 31.2357, radiusM: 30 });
    const [, id, token] = made.qrPayload.split('.');
    expect(id).toBe(made.id);
    const row = await x.inTx(s.c, (tx) =>
      tx.patrolCheckpoint.findUniqueOrThrow({ where: { id: made.id } }),
    );
    expect(row.tokenHash).toBe(
      createHash('sha256')
        .update(
          `jiwar:patrol-checkpoint:v1:${s.c.tenantId}:${made.id}:${token}`,
        )
        .digest('hex'),
    );
    const listed = await list(supervisor);
    const again = listed.data.find((c) => c.id === made.id)!;
    expect(again).not.toHaveProperty('qrPayload');
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(JSON.stringify(listed)).not.toContain(row.tokenHash);
  });

  it('in a zone; a post out of service, or two posts, is refused', async () => {
    const zone = (await x.places(s.manager)).clubhouse;
    const made = await x.checkpoint(s.manager, { zoneId: zone.id });
    expect(made.post.zone?.id).toBe(zone.id);
    expect(made.position).toBeNull();
    const retired = await x.g.gate(s.c);
    await x
      .http('patch', `/gates/${retired.id}`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    const res = await x.checkpointRaw(supervisor, { gateId: retired.id });
    expect(code(res)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });
    expect(fields(res)).toEqual([
      { field: 'gateId', code: 'POST_NOT_AVAILABLE' },
    ]);
    expect(
      (await x.checkpointRaw(supervisor, { gateId, zoneId: zone.id })).status,
    ).toBe(400);
  });

  it('two in service never share a name, in either language', async () => {
    const one = await x.checkpoint(supervisor, { gateId });
    const res = await x.checkpointRaw(supervisor, {
      gateId,
      nameEn: one.nameEn.toUpperCase(),
    });
    expect(code(res)).toEqual({ status: 409, code: 'DUPLICATE_RESOURCE' });
    expect(fields(res)).toEqual([{ field: 'nameEn', code: 'DUPLICATE_VALUE' }]);
  });

  it('renamed and placed; its position removed with null', async () => {
    const one = await x.checkpoint(supervisor, { gateId });
    const placed = (
      await x
        .http(
          'patch',
          `/staff/security/patrols/checkpoints/${one.id}`,
          supervisor.token,
          { nameEn: 'Back fence', position: { lat: 30, lng: 31, radiusM: 80 } },
        )
        .expect(200)
    ).body as CheckpointBody;
    expect(placed).toMatchObject({
      nameEn: 'Back fence',
      position: { lat: 30, lng: 31, radiusM: 80 },
    });
    const cleared = (
      await x
        .http(
          'patch',
          `/staff/security/patrols/checkpoints/${one.id}`,
          supervisor.token,
          { position: null },
        )
        .expect(200)
    ).body as CheckpointBody;
    expect(cleared.position).toBeNull();
    expect(cleared.nameEn).toBe('Back fence');
  });

  it('a reissue answers a new payload, later; the old hash is gone', async () => {
    const one = await x.checkpoint(supervisor, { gateId });
    const before = await x.inTx(s.c, (tx) =>
      tx.patrolCheckpoint.findUniqueOrThrow({ where: { id: one.id } }),
    );
    const again = (
      await x
        .http(
          'post',
          `/staff/security/patrols/checkpoints/${one.id}/reissue`,
          supervisor.token,
        )
        .expect(200)
    ).body as CheckpointBody & { qrPayload: string };
    expect(again.qrPayload).not.toBe(one.qrPayload);
    expect(again.qrPayload.startsWith(`JWK1.${one.id}.`)).toBe(true);
    expect(new Date(again.tokenIssuedAt).getTime()).toBeGreaterThan(
      before.tokenIssuedAt.getTime(),
    );
    const after = await x.inTx(s.c, (tx) =>
      tx.patrolCheckpoint.findUniqueOrThrow({ where: { id: one.id } }),
    );
    expect(after.tokenHash).not.toBe(before.tokenHash);
  });

  it('retired once: then it is neither changed nor reissued, and its name is free again', async () => {
    const one = await x.checkpoint(supervisor, { gateId });
    const path = `/staff/security/patrols/checkpoints/${one.id}`;
    const retired = (
      await x.http('post', `${path}/retire`, supervisor.token).expect(200)
    ).body as CheckpointBody;
    expect(retired.retiredAt).not.toBeNull();
    for (const res of [
      await x.http('post', `${path}/retire`, supervisor.token),
      await x.http('post', `${path}/reissue`, supervisor.token),
      await x.http('patch', path, supervisor.token, { nameEn: 'Again' }),
    ])
      expect(code(res)).toEqual({
        status: 409,
        code: 'PATROL_CHECKPOINT_RETIRED',
      });
    await x.checkpoint(supervisor, { gateId }, { nameEn: one.nameEn });
    const retiredOnly = await list(supervisor, '?status=retired');
    expect(retiredOnly.data.map((c) => c.id)).toContain(one.id);
    expect(retiredOnly.data.every((c) => c.retiredAt !== null)).toBe(true);
  });

  it('kept by patrols.manage: the manager and the supervisor; never a guard', async () => {
    const guard = await x.guard(s.c);
    expect(
      (await x.http('get', '/staff/security/patrols/checkpoints', guard.token))
        .status,
    ).toBe(403);
    const keeper = await x.staff(s.c, ['patrols.manage']);
    await x.checkpoint(keeper, { gateId });
    const reader = await x.staff(s.c, ['guard_reports.read']);
    expect(
      (await x.http('get', '/staff/security/patrols/checkpoints', reader.token))
        .status,
    ).toBe(403);
  });
});
