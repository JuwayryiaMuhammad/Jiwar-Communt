import { deriveRef } from '../../src/engagement/refs/opaque-refs';
import {
  engagementHelpers,
  type EngagementSetUp,
  type Who,
} from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

/**
 * ADR 0040: the ballot is secret against the database. This suite reads
 * the tables as someone holding a full copy of the database (and not the
 * server's secret) would, and looks for any way from a unit, or an account,
 * to what it chose. The running server can tell a unit's own voters their
 * choice while the poll is open (it holds the secret); after the poll ends
 * nobody can.
 */
describe('Community life — the ballot is secret against the database', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof engagementHelpers>;
  let s: EngagementSetUp;
  let voters: { unitId: string; who: Who }[];

  beforeAll(async () => {
    h = await createHttpHarness();
    e = engagementHelpers(h);
    s = await e.setUp();
    voters = await e.voters(s.c, 5);
  }, 180_000);

  afterAll(() => h.close());

  const POLL_TABLES = [
    'polls',
    'poll_options',
    'poll_ballot_boxes',
    'poll_participations',
  ];

  /** Every row of the compound that could bear on a poll, as text. */
  async function dump(pollId: string) {
    return e.inTx(s.c, async (tx) => {
      const out: Record<string, string> = {};
      for (const table of POLL_TABLES) {
        const key = table === 'polls' ? 'id' : 'poll_id';
        out[table] = JSON.stringify(
          await tx.$queryRawUnsafe(
            `SELECT *, xmin::text AS xmin, ctid::text AS ctid FROM "${table}" WHERE "${key}" = $1::uuid`,
            pollId,
          ),
          (_, v: unknown) =>
            typeof v === 'bigint'
              ? v.toString()
              : v instanceof Uint8Array
                ? Buffer.from(v).toString('hex')
                : v,
        );
      }
      return out;
    });
  }

  it('no table of the polls has a column for a unit, an account or a time next to a choice', async () => {
    const columns = await e.inTx(
      s.c,
      (tx) => tx.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name::text, column_name::text
          FROM information_schema.columns
         WHERE table_name = ANY(${POLL_TABLES}) ORDER BY 1, 2`,
    );
    const of = (table: string) =>
      columns.filter((c) => c.table_name === table).map((c) => c.column_name);
    // The ballots: the poll they are of, and the box. Nothing else.
    expect(of('poll_ballot_boxes')).toEqual([
      'ballots',
      'poll_id',
      'tenant_id',
    ]);
    // Who took part, written at the close: a unit, and no choice or time.
    expect(of('poll_participations')).toEqual([
      'poll_id',
      'tenant_id',
      'unit_id',
    ]);
    // An option holds a count, never a voter.
    expect(of('poll_options')).toEqual([
      'final_count',
      'id',
      'label_ar',
      'label_en',
      'poll_id',
      'position',
      'tenant_id',
    ]);
    // No other table of the database points at a ballot or an option.
    const referrers = await e.inTx(
      s.c,
      (tx) => tx.$queryRaw<{ table_name: string }[]>`
        SELECT DISTINCT cl.relname::text AS table_name
          FROM pg_constraint co
          JOIN pg_class cl ON cl.oid = co.conrelid
          JOIN pg_class target ON target.oid = co.confrelid
         WHERE co.contype = 'f'
           AND target.relname IN ('poll_options', 'poll_ballot_boxes')`,
    );
    expect(referrers).toEqual([]);
  });

  it('while a poll is open the database holds no unit and no account with a ballot, in any column of any row', async () => {
    const id = await e.poll(s.manager);
    const [yes, no] = await e.optionIds(s.manager, id);
    for (const [i, v] of voters.entries())
      await e.vote(v.who, id, [i % 2 ? yes : no]).expect(201);
    await e.vote(s.owner, id, [yes]).expect(201);

    const tables = await dump(id);
    const everything = Object.values(tables).join('\n');
    for (const v of [...voters, { unitId: s.home.id, who: s.owner }]) {
      expect(everything).not.toContain(v.unitId);
      expect(everything).not.toContain(v.who.id);
    }
    // Nobody took part yet, as far as the tables say: that is written at the close.
    expect(JSON.parse(tables.poll_participations)).toEqual([]);

    // Six ballots in ONE row: no per-ballot row, so no per-ballot system
    // column to match against the audit entry written with a vote.
    const boxes = JSON.parse(tables.poll_ballot_boxes) as {
      ballots: Record<string, string[]>;
      xmin: string;
    }[];
    expect(boxes).toHaveLength(1);
    const keys = Object.keys(boxes[0].ballots);
    expect(keys).toHaveLength(6);
    // A key is 32 bytes of HMAC, not an id.
    for (const key of keys) {
      expect(Buffer.from(key, 'base64url')).toHaveLength(32);
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    // The keys come back in an order that is not the order of voting.
    expect(keys).toEqual(
      [...keys].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)),
    );

    // The audit trail says who voted for which unit and when; never what.
    const audit = await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.auditLog.findMany({
        where: { action: 'poll.vote_cast', targetId: id },
      }),
    );
    expect(audit).toHaveLength(6);
    const trail = JSON.stringify(audit);
    expect(trail).not.toContain(yes);
    expect(trail).not.toContain(no);
    for (const key of keys) expect(trail).not.toContain(key);
    for (const row of audit)
      expect(Object.keys(row.metadata as object).sort()).toEqual([
        'changed',
        'unitId',
      ]);
    // No audit row shares a transaction with a ballot: the box's row was
    // last written by the last vote alone, whatever each ballot's age.
    const xmins = await e.inTx(
      s.c,
      (tx) => tx.$queryRaw<{ xmin: string }[]>`
        SELECT xmin::text AS xmin FROM audit_log
         WHERE action = 'poll.vote_cast' AND target_id = ${id}::uuid`,
    );
    expect(
      xmins.filter((r) => r.xmin === boxes[0].xmin).length,
    ).toBeLessThanOrEqual(1);
  });

  it('a ballot’s key cannot be derived from what the database holds: it needs the server’s secret', async () => {
    const id = await e.poll(s.manager);
    const [yes] = await e.optionIds(s.manager, id);
    await e.vote(s.owner, id, [yes]).expect(201);
    const poll = await e.x.asManager(s.c, () =>
      e.x.prisma.tenant.poll.findUniqueOrThrow({
        where: { id },
        include: { ballotBox: true },
      }),
    );
    const [key] = Object.keys(poll.ballotBox!.ballots as object);
    const salt = Buffer.from(poll.ballotSalt!).toString('hex');
    const derive = (secret: string) =>
      Buffer.from(deriveRef(secret, 'ballot', salt, id, s.home.id)).toString(
        'base64url',
      );
    // With the secret (which only the server's environment holds): the key.
    expect(derive(required('ENGAGEMENT_REF_SECRET'))).toBe(key);
    // With everything in the database and any other secret: not the key.
    for (const guess of ['', salt, id, s.home.id, 'x'.repeat(32)])
      expect(derive(guess)).not.toBe(key);
    // And the secret is nowhere in the database's own settings.
    const settings = await e.inTx(
      s.c,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_settings
         WHERE setting = ${required('ENGAGEMENT_REF_SECRET')}`,
    );
    expect(Number(settings[0].n)).toBe(0);
  });

  it('no API answer tells a unit’s choice to the staff, to another unit, or to a member who does not cast its vote', async () => {
    const member = await e.family(s.c, s.home.id, s.owner);
    const id = await e.poll(s.manager);
    const [yes, no] = await e.optionIds(s.manager, id);
    await e.vote(s.owner, id, [yes]).expect(201);
    for (const v of voters) await e.vote(v.who, id, [no]).expect(201);

    // The owner's own view is the only one carrying the home's choice.
    const own = await e.pollAs(s.owner, id);
    expect(own.units).toEqual([
      { unitId: s.home.id, mayVote: true, voted: true, choice: [yes] },
    ]);
    const staffViews = [
      (await e.http('get', `/community/polls/${id}`, s.manager.token)).body,
      (await e.http('get', '/community/polls?limit=100', s.manager.token)).body,
      (await e.http('get', `/community/polls/${id}/audience`, s.manager.token))
        .body,
    ].map((b) => JSON.stringify(b));
    for (const view of staffViews) {
      expect(view).not.toContain('"choice"');
      expect(view).not.toContain('"units":[');
      expect(view).not.toContain(s.home.id);
    }
    // Six votes, one for "yes": with the counts shown, only the count.
    const staff = await e.pollForStaff(s.manager, id);
    expect(staff.options.map((o) => o.votes)).toEqual([1, 5]);
    // Another unit, and the home's member without the grant: no choice.
    expect((await e.pollAs(voters[0].who, id)).units![0].unitId).toBe(
      voters[0].unitId,
    );
    expect(JSON.stringify(await e.pollAs(voters[0].who, id))).not.toContain(
      s.home.id,
    );
    expect((await e.pollAs(member, id)).units).toEqual([
      { unitId: s.home.id, mayVote: false, voted: true, choice: null },
    ]);
  });

  it.each(['close', 'cancel'] as const)(
    'after a %s nothing individual is left: the box is gone, the salt cleared, and no choice can be told again',
    async (action) => {
      const id = await e.poll(s.manager);
      const [yes, no] = await e.optionIds(s.manager, id);
      await e.vote(s.owner, id, [yes]).expect(201);
      await e.vote(voters[0].who, id, [no]).expect(201);
      const open = await dump(id);
      const [key] = Object.keys(
        (JSON.parse(open.poll_ballot_boxes) as { ballots: object }[])[0]
          .ballots,
      );

      await e
        .http('post', `/community/polls/${id}/${action}`, s.manager.token)
        .expect(204);
      const after = await dump(id);
      expect(JSON.parse(after.poll_ballot_boxes)).toEqual([]);
      const [poll] = JSON.parse(after.polls) as {
        ballot_salt: string | null;
      }[];
      expect(poll.ballot_salt).toBeNull();
      expect(Object.values(after).join('\n')).not.toContain(key);
      // The owner, who was told their choice a moment ago, no longer is.
      expect((await e.pollAs(s.owner, id)).units![0].choice).toBeNull();

      const participations = JSON.parse(after.poll_participations) as {
        unit_id: string;
        xmin: string;
        ctid: string;
      }[];
      if (action === 'cancel') {
        expect(participations).toEqual([]);
        return;
      }
      // Who took part, for all units at once: one transaction, unit order,
      // nothing that says when each voted or what.
      expect(participations.map((p) => p.unit_id).sort()).toEqual(
        [s.home.id, voters[0].unitId].sort(),
      );
      expect(new Set(participations.map((p) => p.xmin)).size).toBe(1);
      const options = JSON.parse(after.poll_options) as {
        final_count: number;
      }[];
      expect(options.map((o) => o.final_count).sort()).toEqual([1, 1]);
    },
  );

  it('a vote’s Idempotency-Key is stored without its body: the stored hash is the same whichever option was sent', async () => {
    const id = await e.poll(s.manager);
    const [yes, no] = await e.optionIds(s.manager, id);
    const hashOf = async (optionId: string, key: string) => {
      await e
        .vote(s.owner, id, [optionId], {}, { 'Idempotency-Key': key })
        .expect(201);
      const rows = await e.inTx(s.c, (tx) =>
        tx.$queryRawUnsafe<Record<string, unknown>[]>(
          `SELECT * FROM idempotency_keys WHERE key = $1`,
          key,
        ),
      );
      expect(rows).toHaveLength(1);
      // Nothing of the row is the option, by value.
      expect(JSON.stringify(rows[0])).not.toContain(optionId);
      return rows[0].request_hash;
    };
    // The same voter, the same poll, the two options, a key each: were the
    // body hashed, the two hashes would differ and an attacker holding the
    // table could tell which option an account sent by trying both.
    expect(await hashOf(yes, `secret-yes-${id}`)).toBe(
      await hashOf(no, `secret-no-${id}`),
    );
  });
});
