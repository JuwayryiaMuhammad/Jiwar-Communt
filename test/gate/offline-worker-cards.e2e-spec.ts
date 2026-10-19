import { IdentifierHasher } from '../../src/core/auth/identifier';
import { WorkersService } from '../../src/community/workers/workers.service';
import { deriveEngagementToken } from '../../src/community/workers/engagement-tokens';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { offlineHelpers } from '../setup/offline';

/** The test ring (test/setup/test-env.ts): version 2 is current. */
const ring = new Map(
  process.env
    .ENGAGEMENT_TOKEN_KEYS!.split(',')
    .map((p) => p.split(':') as [string, string])
    .map(([v, k]) => [Number(v), k]),
);

/**
 * ADR 0057, a worker card derived with a versioned key: what the gate's
 * offline bundle derives again. A new card takes the current version and
 * the next number; a printed card keeps the version it was derived with,
 * so a rotation never stops it at the gate.
 */
describe('Gate offline — worker cards derived with a versioned key (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let hasher: IdentifierHasher;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Worker Cards Court');
    hasher = h.moduleRef.get(IdentifierHasher);
  }, 180_000);

  afterAll(() => h.close());

  const engagement = (id: string) =>
    o.inTx(s.c, (tx) =>
      tx.workerEngagement.findUniqueOrThrow({ where: { id } }),
    );
  const verify = async (body: { code?: string; qr?: string }) =>
    (await o.verifyRaw(s.guard, body).expect(200)).body as {
      result: string;
      subject: string;
      subjectId: string | null;
    };
  /** The card (engagement, seq) derived with version `v`, as the server would. */
  const derived = (engagementId: string, seq: number, v: number) => {
    const token = deriveEngagementToken(
      ring.get(v)!,
      s.c.tenantId,
      engagementId,
      seq,
    );
    const code = hasher.deriveCode(token, 8);
    return {
      token,
      code,
      codeHash: hasher.hashWorkerCode(s.c.tenantId, code),
      qrHash: hasher.hashQrToken(s.c.tenantId, token),
    };
  };

  it('an approval derives the first card with the current version', async () => {
    const w = await o.workerWithCard(s.c, s.alice, s.home.id);
    const row = await engagement(w.engagementId);
    expect([row.tokenSeq, row.tokenKeyVersion]).toEqual([1, 2]);
    const card = derived(w.engagementId, 1, 2);
    expect([w.code, w.qr]).toEqual([card.code, `JWR1.${card.token}`]);
    expect([row.accessCodeHash, row.qrTokenHash]).toEqual([
      card.codeHash,
      card.qrHash,
    ]);
    // The gate knows it by its hashes, as any card.
    expect(await verify({ code: w.code })).toMatchObject({
      result: 'valid',
      subjectId: w.engagementId,
    });
    expect(await verify({ qr: w.qr })).toMatchObject({ result: 'valid' });
  });

  it('a reissue is the next number; the old card dies with it', async () => {
    const w = await o.workerWithCard(s.c, s.alice, s.home.id);
    const issued = await o.as(s.c, { id: s.alice.id, type: 'resident' }, () =>
      h.moduleRef.get(WorkersService).reissueCode(w.engagementId, 'lost'),
    );
    const row = await engagement(w.engagementId);
    expect([row.tokenSeq, row.tokenKeyVersion]).toEqual([2, 2]);
    expect(issued.accessCode).toBe(derived(w.engagementId, 2, 2).code);
    expect(await verify({ code: w.code })).toMatchObject({
      result: 'invalid',
    });
    expect(await verify({ code: issued.accessCode })).toMatchObject({
      result: 'valid',
    });
  });

  it('a rotation: a card derived with version 1 still opens the gate while 2 is current', async () => {
    const w = await o.workerWithCard(s.c, s.alice, s.home.id);
    // Printed before the rotation: number 7, version 1, as the server
    // derived it then (written as such; the app now derives with 2).
    const old = derived(w.engagementId, 7, 1);
    await superuserSql(
      `UPDATE worker_engagements
          SET access_code_hash = $2, qr_token_hash = $3,
              token_seq = 7, token_key_version = 1
        WHERE id = $1`,
      [w.engagementId, old.codeHash, old.qrHash],
    );
    expect(await verify({ code: old.code })).toMatchObject({
      result: 'valid',
      subjectId: w.engagementId,
    });
    expect(await verify({ qr: `JWR1.${old.token}` })).toMatchObject({
      result: 'valid',
    });
    // Its reissue takes the current version, from the next number.
    const issued = await o.as(s.c, { id: s.alice.id, type: 'resident' }, () =>
      h.moduleRef.get(WorkersService).reissueCode(w.engagementId, 'other'),
    );
    const row = await engagement(w.engagementId);
    expect([row.tokenSeq, row.tokenKeyVersion]).toEqual([8, 2]);
    expect(issued.accessCode).toBe(derived(w.engagementId, 8, 2).code);
  });

  it('a card from before ADR 0057 is random: it keeps working, with no derivation', async () => {
    const w = await o.workerWithCard(s.c, s.alice, s.home.id);
    await superuserSql(
      `UPDATE worker_engagements SET token_seq = NULL, token_key_version = NULL
        WHERE id = $1`,
      [w.engagementId],
    );
    expect(await verify({ code: w.code })).toMatchObject({ result: 'valid' });
    await expect(
      superuserSql(
        `UPDATE worker_engagements SET token_seq = 3 WHERE id = $1`,
        [w.engagementId],
      ),
    ).rejects.toThrow(/worker_engagements_token_derivation/);
  });
});
