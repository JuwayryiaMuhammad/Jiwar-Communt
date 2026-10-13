import { Client } from 'pg';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  neighboursHelpers,
  type NeighboursSetUp,
  type Who,
} from '../setup/neighbours';
import { required } from '../setup/test-env';

/**
 * ADR 0042: names show only when BOTH sides of a masked conversation have
 * agreed, and then a first name and nothing more. One agreement shows
 * nothing and may be taken back; two cannot be. The agreements race for
 * real here, and against the conversation's lock held from outside.
 */
describe('Neighbours — agreeing to show names', () => {
  let h: HttpHarness;
  let n: ReturnType<typeof neighboursHelpers>;
  let s: NeighboursSetUp;
  let db: Client;
  let first: Record<string, string>;
  let rest: Record<string, string>;

  beforeAll(async () => {
    h = await createHttpHarness();
    n = neighboursHelpers(h);
    s = await n.setUp();
    await n.settings(s.c, s.manager, {
      maxOpenPosts: 50,
      maxNewConversationsPerDay: 100,
    });
    // Names of three words, so "a first name and nothing more" can be seen.
    for (const [who, fullName] of [
      [s.alice, 'Mona Adel Hassan'],
      [s.bob, 'Karim Samir Fouad'],
    ] as const)
      await n.x.asManager(s.c, () =>
        n.x.prisma.tenant.account.update({
          where: { id: who.id },
          data: { fullName },
        }),
      );
    const accounts = await n.x.asManager(s.c, () =>
      n.x.prisma.tenant.account.findMany({
        where: { id: { in: [s.alice.id, s.bob.id] } },
      }),
    );
    first = Object.fromEntries(
      accounts.map((a) => [a.id, a.fullName!.split(' ')[0]]),
    );
    rest = Object.fromEntries(
      accounts.map((a) => [a.id, a.fullName!.split(' ').slice(1).join(' ')]),
    );
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const ROUNDS = 3;
  type View = {
    id: string;
    namesRevealed: boolean;
    iAgreed: boolean;
    theyAgreed: boolean;
    other: { building: string | null; firstName: string | null };
  };
  const fresh = async () =>
    n.conversation(
      s.bob,
      await n.post(s.alice, { kind: 'lend', body: 'A rake' }),
    );
  const view = async (who: Who, id: string) =>
    (
      await n
        .http('get', `/neighbour-conversations/${id}`, who.token)
        .expect(200)
    ).body as View;
  const reveal = (who: Who, id: string) =>
    n.http('post', `/neighbour-conversations/${id}/reveal`, who.token);
  const unreveal = (who: Who, id: string) =>
    n.http('delete', `/neighbour-conversations/${id}/reveal`, who.token);
  const row = (id: string) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.neighbourConversation.findUniqueOrThrow({
        where: { id },
      }),
    );
  const audits = (id: string) =>
    n.x.asManager(s.c, () =>
      n.x.prisma.tenant.auditLog.count({
        where: {
          action: 'neighbour_conversation.names_revealed',
          targetId: id,
        },
      }),
    );
  const told = async (who: Who, id: string) =>
    (await n.notifications(s.c, who.id))
      .filter((x) => x.targetId === id)
      .map((x) => x.kind)
      .filter((k) => /reveal|names/.test(k));

  it('one side agreeing shows nothing to either; the other is told someone is waiting', async () => {
    const id = await fresh();
    const mine = (await reveal(s.bob, id).expect(200)).body as View;
    expect(mine).toMatchObject({
      namesRevealed: false,
      iAgreed: true,
      theyAgreed: false,
      other: { building: 'A', firstName: null },
    });
    expect(await view(s.alice, id)).toMatchObject({
      namesRevealed: false,
      iAgreed: false,
      theyAgreed: true,
      other: { building: 'B', firstName: null },
    });
    expect(await told(s.alice, id)).toEqual([
      'neighbour_conversation.reveal_requested',
    ]);
    expect(await audits(id)).toBe(0);
    // Agreeing again changes nothing and tells nobody again.
    await reveal(s.bob, id).expect(200);
    expect(await told(s.alice, id)).toHaveLength(1);
  });

  it('both agreeing shows each the other’s first name: never the rest of it, a unit or an id', async () => {
    const id = await fresh();
    await reveal(s.bob, id).expect(200);
    await reveal(s.alice, id).expect(200);
    const bob = await view(s.bob, id);
    const alice = await view(s.alice, id);
    expect(bob).toMatchObject({
      namesRevealed: true,
      other: { building: 'A', firstName: first[s.alice.id] },
    });
    expect(alice).toMatchObject({
      namesRevealed: true,
      other: { building: 'B', firstName: first[s.bob.id] },
    });
    for (const [text, other, home] of [
      [JSON.stringify(bob), s.alice, s.homeA],
      [JSON.stringify(alice), s.bob, s.homeB],
    ] as const) {
      expect(text).not.toContain(other.id);
      expect(text).not.toContain(rest[other.id]);
      expect(text).not.toContain(home.code);
      expect(text).not.toContain(home.id);
    }
    expect(await audits(id)).toBe(1);
    expect(await told(s.bob, id)).toEqual([
      'neighbour_conversation.names_revealed',
    ]);
    // The notification itself carries no name: it is read in the app.
    const rows = (await n.notifications(s.c, s.bob.id)).filter(
      (x) => x.targetId === id,
    );
    expect(JSON.stringify(rows)).not.toContain(first[s.alice.id]);
  });

  it('an agreement is taken back while the other has not agreed, and never after', async () => {
    const id = await fresh();
    await reveal(s.bob, id).expect(200);
    expect((await unreveal(s.bob, id).expect(200)).body).toMatchObject({
      iAgreed: false,
      namesRevealed: false,
    });
    // Alice agreeing now shows nothing: Bob took his back.
    await reveal(s.alice, id).expect(200);
    expect(await view(s.bob, id)).toMatchObject({
      namesRevealed: false,
      theyAgreed: true,
      other: { firstName: null },
    });
    await reveal(s.bob, id).expect(200);
    for (const who of [s.alice, s.bob])
      expect((await unreveal(who, id).expect(409)).body).toMatchObject({
        code: 'NEIGHBOUR_NAMES_ALREADY_REVEALED',
      });
    expect((await view(s.alice, id)).namesRevealed).toBe(true);
  });

  it('both agreeing at once: names show, once, to both', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await fresh();
      const results = await Promise.all([
        reveal(s.bob, id),
        reveal(s.alice, id),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const after = await row(id);
      expect(after.authorRevealAt).not.toBeNull();
      expect(after.responderRevealAt).not.toBeNull();
      expect(await audits(id)).toBe(1);
      // Exactly one of the two answers was the second agreement.
      expect(
        results.filter((r) => (r.body as View).namesRevealed).length,
      ).toBeGreaterThanOrEqual(1);
      expect((await view(s.bob, id)).other.firstName).toBe(first[s.alice.id]);
      expect((await view(s.alice, id)).other.firstName).toBe(first[s.bob.id]);
      // Each was told once: one that the other waits, one that names show.
      const kinds = [...(await told(s.bob, id)), ...(await told(s.alice, id))];
      expect(kinds.sort()).toEqual([
        'neighbour_conversation.names_revealed',
        'neighbour_conversation.reveal_requested',
      ]);
    }
  });

  it('one side agreeing twice at once is one agreement, and shows nothing', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await fresh();
      const results = await Promise.all([reveal(s.bob, id), reveal(s.bob, id)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await view(s.alice, id)).toMatchObject({
        namesRevealed: false,
        theyAgreed: true,
      });
      expect(await told(s.alice, id)).toHaveLength(1);
      expect(await audits(id)).toBe(0);
    }
  });

  it('taking back against the other’s agreement, at once: either names show and stay, or none ever showed', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await fresh();
      await reveal(s.bob, id).expect(200);
      const [back, other] = await Promise.all([
        unreveal(s.bob, id),
        reveal(s.alice, id),
      ]);
      expect(other.status).toBe(200);
      const after = await row(id);
      const shown =
        after.authorRevealAt !== null && after.responderRevealAt !== null;
      if (back.status === 409) {
        // Alice was first: both had agreed when Bob tried to take his back.
        expect(back.body).toMatchObject({
          code: 'NEIGHBOUR_NAMES_ALREADY_REVEALED',
        });
        expect(shown).toBe(true);
        expect(await audits(id)).toBe(1);
        expect((await view(s.bob, id)).other.firstName).toBe(first[s.alice.id]);
      } else {
        // Bob was first: Alice's agreement met none, and shows nothing.
        expect(back.status).toBe(200);
        expect(shown).toBe(false);
        expect(after.responderRevealAt).toBeNull();
        expect(await audits(id)).toBe(0);
        expect((other.body as View).namesRevealed).toBe(false);
        expect((await view(s.bob, id)).other.firstName).toBeNull();
        expect((await view(s.alice, id)).other.firstName).toBeNull();
      }
    }
  });

  describe('with the conversation held', () => {
    async function holding(id: string) {
      const held = new Client({
        connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
      });
      await held.connect();
      await held.query('BEGIN');
      await held.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        s.c.tenantId,
      ]);
      await held.query(
        `SELECT id FROM neighbour_conversations WHERE id = $1 FOR UPDATE`,
        [id],
      );
      return held;
    }
    const settle = async (
      held: Client,
      sql?: string,
      params: unknown[] = [],
    ) => {
      if (sql) await held.query(sql, params);
      await held.query('COMMIT');
      await held.end();
    };
    const waitForLockWaiter = async () => {
      for (let i = 0; i < 100; i++) {
        const waiting = await db.query(
          `SELECT count(*) FROM pg_locks WHERE NOT granted`,
        );
        if (Number((waiting.rows[0] as { count: string }).count) > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('the request never waited on the conversation');
    };

    it('an agreement waits for it, then finds the other’s and shows names', async () => {
      const id = await fresh();
      const held = await holding(id);
      const waiting = reveal(s.bob, id).then((r) => r);
      await waitForLockWaiter();
      await settle(
        held,
        `UPDATE neighbour_conversations SET author_reveal_at = now() WHERE id = $1`,
        [id],
      );
      const res = await waiting;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        namesRevealed: true,
        other: { firstName: first[s.alice.id] },
      });
      expect(await audits(id)).toBe(1);
    });

    it('a taking-back waits for it, then finds the other agreed and is refused', async () => {
      const id = await fresh();
      await reveal(s.bob, id).expect(200);
      const held = await holding(id);
      const waiting = unreveal(s.bob, id).then((r) => r);
      await waitForLockWaiter();
      await settle(
        held,
        `UPDATE neighbour_conversations SET author_reveal_at = now() WHERE id = $1`,
        [id],
      );
      const res = await waiting;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'NEIGHBOUR_NAMES_ALREADY_REVEALED',
      });
      expect((await row(id)).responderRevealAt).not.toBeNull();
    });

    it('an agreement waits for it, then finds the conversation closed and is refused', async () => {
      const id = await fresh();
      const held = await holding(id);
      const waiting = reveal(s.bob, id).then((r) => r);
      await waitForLockWaiter();
      await settle(
        held,
        `UPDATE neighbour_conversations SET closed_at = now(), close_reason = 'blocked' WHERE id = $1`,
        [id],
      );
      const res = await waiting;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'NEIGHBOUR_CONVERSATION_CLOSED' });
      expect((await row(id)).responderRevealAt).toBeNull();
    });
  });
});
