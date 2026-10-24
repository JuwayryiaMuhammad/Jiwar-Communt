import { boardAppealHelpers } from '../setup/board-appeals';
import { eraseNow } from '../setup/erasure';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

interface RepBody {
  id: string;
  building: string;
  accountId: string;
  endedAt: string | null;
  endReason: string | null;
}

interface MatterBody {
  id: string;
  action: string;
  building: string;
  accountId: string;
  status: string;
  raisedByMe: boolean;
  decision: {
    decision: string;
    rationale: string;
    effect: string | null;
    effectReason: string | null;
  } | null;
  motions: { id: string; status: string; recused: number }[];
}

/**
 * ADR 0059: naming a building's representative, an owner of a unit there,
 * or ending a term is a board decision: a sitting member raises the matter,
 * one pending per building, and the board decides it by its motions (ADR
 * 0055), whom it names recused. Its residents see their first name and
 * write to them privately; the representative sees each writer's unit and
 * first name; the term ends by the board, by a new one, or when they no
 * longer own a unit there.
 */
describe('The board — building representatives', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    // o(0), o(1), o(2) sit; all eight own a unit each in building A.
    s = await a.setUp(8, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const raiseRaw = (by: { token: string }, body: Record<string, unknown>) =>
    a.http('post', '/board/representatives/matters', by.token, body);
  const raise = async (body: Record<string, unknown>, by = o(0)) => {
    const res = await raiseRaw(by, body);
    if (res.status !== 201)
      throw new Error(`raise: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as MatterBody;
  };
  const matter = async (id: string) =>
    (
      await a
        .http('get', `/board/representatives/matters/${id}`, o(0).token)
        .expect(200)
    ).body as MatterBody;
  const proposeOn = (
    by: { token: string },
    id: string,
    outcome: 'approve' | 'reject' = 'approve',
  ) =>
    a.http('post', `/board/representatives/matters/${id}/motions`, by.token, {
      outcome,
      rationale: 'Known to the building and willing.',
    });
  /** A motion on the matter, proposed by o(0), voted for by o(0) and o(1): carried. */
  const carry = async (
    id: string,
    outcome: 'approve' | 'reject' = 'approve',
  ) => {
    const motion = (await proposeOn(o(0), id, outcome).expect(201)).body as {
      id: string;
    };
    await a.vote(o(0), motion.id, 'for').expect(201);
    await a.vote(o(1), motion.id, 'for').expect(201);
    return matter(id);
  };
  const representatives = async () =>
    (await a.http('get', '/board/representatives', o(0).token).expect(200))
      .body as RepBody[];
  const sittingIn = async (building: string) =>
    (await representatives()).filter(
      (r) => r.building === building && !r.endedAt,
    );
  /** Raised and carried: the building's sitting representative after. */
  const appoint = async (accountId: string) => {
    const decided = await carry(
      (await raise({ action: 'appoint', building: 'A', accountId })).id,
    );
    expect(decided.decision).toMatchObject({ effect: 'applied' });
    return sittingIn('A');
  };
  const fullName = async (accountId: string) =>
    (
      await a.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({
          where: { id: accountId },
          select: { fullName: true },
        }),
      )
    ).fullName ?? '';
  /** The account's first name, as the representative views show it. */
  const firstName = async (accountId: string) =>
    (await fullName(accountId)).split(' ')[0];
  const write = (
    as: { token: string },
    repId: string,
    body = 'The lift is down.',
  ) =>
    a.http('post', `/me/representatives/${repId}/messages`, as.token, { body });
  type Fields = { fields: { field: string; code: string }[] };

  it('a sitting member raises a matter; not a resident or the manager; its shape by its action', async () => {
    const body = { action: 'appoint', building: 'A', accountId: o(3).id };
    expect(code(await raiseRaw(o(4), body).expect(403))).toBe('FORBIDDEN');
    expect(code(await raiseRaw(s.manager, body).expect(403))).toBe('FORBIDDEN');
    const missing = (
      await raiseRaw(o(0), { action: 'appoint', building: 'A' }).expect(400)
    ).body as Fields;
    expect(missing.fields).toEqual([
      expect.objectContaining({ field: 'accountId', code: 'FIELD_REQUIRED' }),
    ]);
    const extra = (
      await raiseRaw(o(0), {
        action: 'end',
        representativeId: o(3).id,
        building: 'A',
      }).expect(400)
    ).body as Fields;
    expect(extra.fields).toEqual([
      expect.objectContaining({ field: 'building', code: 'FIELD_NOT_ALLOWED' }),
    ]);
    // An owner elsewhere: not of the building.
    const elsewhere = await a.unit(s.c, 'B');
    const outsider = await a.owner(s.c, elsewhere.id);
    expect(
      code(
        await raiseRaw(o(0), { ...body, accountId: outsider.id }).expect(409),
      ),
    ).toBe('REPRESENTATIVE_NOT_AN_OWNER');
    expect(
      code(await raiseRaw(o(0), { ...body, building: 'Nowhere' }).expect(404)),
    ).toBe('REPRESENTATIVE_BUILDING_NOT_FOUND');
    // The board's choice: the buildings, and who may represent one.
    expect(
      (
        await a
          .http('get', '/board/representatives/buildings', o(0).token)
          .expect(200)
      ).body,
    ).toEqual(expect.arrayContaining(['A', 'B']));
    const candidates = (
      await a
        .http('get', '/board/representatives/candidates?building=A', o(0).token)
        .expect(200)
    ).body as { accountId: string }[];
    expect(candidates.map((c) => c.accountId)).toEqual(
      expect.arrayContaining(s.owners.map((x) => x.id)),
    );
    expect(candidates.map((c) => c.accountId)).not.toContain(outsider.id);
  });

  it('nobody sits until a carried motion approves it; one pending per building', async () => {
    const raised = await raise({
      action: 'appoint',
      building: 'A',
      accountId: o(3).id,
    });
    expect(raised).toMatchObject({
      action: 'appoint',
      status: 'pending',
      raisedByMe: true,
      decision: null,
      motions: [],
    });
    expect(
      code(
        await raiseRaw(o(1), {
          action: 'appoint',
          building: 'A',
          accountId: o(4).id,
        }).expect(409),
      ),
    ).toBe('REPRESENTATIVE_MATTER_PENDING');
    expect(
      (await a.http('get', '/me/representatives', o(5).token).expect(200)).body,
    ).toEqual([]);
    const decided = await carry(raised.id);
    expect(decided).toMatchObject({
      status: 'approved',
      decision: {
        decision: 'approved',
        rationale: 'Known to the building and willing.',
        effect: 'applied',
        effectReason: null,
      },
      motions: [expect.objectContaining({ status: 'carried' })],
    });
    const [rep] = await sittingIn('A');
    expect(rep).toMatchObject({ accountId: o(3).id });
    expect(await a.notifications(s.c, o(3).id)).toContainEqual(
      expect.objectContaining({
        kind: 'governance_representative.appointed',
        params: { building: 'A' },
      }),
    );
    // The building's residents see a first name and since when.
    const seen = (
      await a.http('get', '/me/representatives', o(5).token).expect(200)
    ).body as { id: string; firstName: string; since: string }[];
    expect(seen).toEqual([
      {
        id: rep.id,
        building: 'A',
        firstName: await firstName(o(3).id),
        since: expect.any(String) as string,
      },
    ]);
    // Naming the sitting one again is refused.
    expect(
      code(
        await raiseRaw(o(0), {
          action: 'appoint',
          building: 'A',
          accountId: o(3).id,
        }).expect(409),
      ),
    ).toBe('REPRESENTATIVE_ALREADY_SITTING');
  });

  it('a resident writes privately; the representative sees the unit and a first name, and answers', async () => {
    const [rep] = (
      await a.http('get', '/me/representatives', o(4).token).expect(200)
    ).body as { id: string }[];
    await write(o(4), rep.id, 'The lift is down again.').expect(201);
    const threads = (
      await a.http('get', '/me/representation/threads', o(3).token).expect(200)
    ).body as {
      data: { id: string; unitCode: string; writerFirstName: string }[];
    };
    const writer = await firstName(o(4).id);
    const thread = threads.data.find((t) => t.writerFirstName === writer)!;
    expect(thread).toMatchObject({ unitCode: expect.any(String) as string });
    // A first name only, never the whole.
    const whole = await fullName(o(4).id);
    if (whole.includes(' '))
      expect(JSON.stringify(threads)).not.toContain(whole);
    await a
      .http(
        'post',
        `/me/representation/threads/${thread.id}/messages`,
        o(3).token,
        { body: 'I will raise it with the board.' },
      )
      .expect(201);
    const mine = (
      await a
        .http('get', `/me/representatives/${rep.id}/messages`, o(4).token)
        .expect(200)
    ).body as { data: { side: string; body: string }[] };
    expect(mine.data.map((m) => [m.side, m.body])).toEqual([
      ['resident', 'The lift is down again.'],
      ['representative', 'I will raise it with the board.'],
    ]);
    // Another resident's own thread is theirs: empty.
    expect(
      (
        (
          await a
            .http('get', `/me/representatives/${rep.id}/messages`, o(5).token)
            .expect(200)
        ).body as { data: unknown[] }
      ).data,
    ).toEqual([]);
    // Someone who is not the representative does not read the thread.
    expect(
      code(
        await a
          .http(
            'get',
            `/me/representation/threads/${thread.id}/messages`,
            o(5).token,
          )
          .expect(404),
      ),
    ).toBe('REPRESENTATIVE_THREAD_NOT_FOUND');
    // Nobody outside the building writes.
    const elsewhere = await a.unit(s.c, 'C');
    const outsider = await a.owner(s.c, elsewhere.id);
    expect(code(await write(outsider, rep.id).expect(404))).toBe(
      'REPRESENTATIVE_NOT_FOUND',
    );
  });

  it('a member the matter names is recused; a rejection and a withdrawal change nothing', async () => {
    const before = await sittingIn('A');
    const raised = await raise({
      action: 'appoint',
      building: 'A',
      accountId: o(2).id,
    });
    expect(code(await proposeOn(o(2), raised.id).expect(403))).toBe(
      'BOARD_MEMBER_RECUSED',
    );
    expect(await carry(raised.id, 'reject')).toMatchObject({
      status: 'rejected',
      decision: { decision: 'rejected', effect: null },
      motions: [expect.objectContaining({ recused: 1 })],
    });
    expect(await sittingIn('A')).toEqual(before);
    // Withdrawn by its raiser only; its open motion closes with it.
    const again = await raise(
      { action: 'appoint', building: 'A', accountId: o(4).id },
      o(1),
    );
    await proposeOn(o(0), again.id).expect(201);
    const withdraw = (as: { token: string }) =>
      a.http(
        'post',
        `/board/representatives/matters/${again.id}/withdraw`,
        as.token,
      );
    expect(code(await withdraw(o(0)).expect(403))).toBe(
      'REPRESENTATIVE_MATTER_NOT_YOURS',
    );
    expect((await withdraw(o(1)).expect(200)).body).toMatchObject({
      status: 'withdrawn',
      motions: [expect.objectContaining({ status: 'withdrawn' })],
    });
    expect(code(await withdraw(o(1)).expect(409))).toBe('BOARD_MATTER_DECIDED');
    expect(await sittingIn('A')).toEqual(before);
  });

  it('a new one replaces the sitting one; the ended term takes no message', async () => {
    const [before] = await sittingIn('A');
    const [next] = await appoint(o(5).id);
    expect(
      (await representatives()).find((r) => r.id === before.id),
    ).toMatchObject({ endReason: 'replaced' });
    expect(next).toMatchObject({ accountId: o(5).id });
    expect(code(await write(o(4), before.id).expect(409))).toBe(
      'REPRESENTATIVE_ENDED',
    );
  });

  it('two raised at once for one building: one is pending (×3)', async () => {
    for (let i = 0; i < 3; i++) {
      const [x, y] = await Promise.all([
        raiseRaw(o(0), {
          action: 'appoint',
          building: 'A',
          accountId: o(6).id,
        }),
        raiseRaw(o(1), {
          action: 'appoint',
          building: 'A',
          accountId: o(7).id,
        }),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      const [won, by] = x.status === 201 ? [x, o(0)] : [y, o(1)];
      expect(code(x.status === 201 ? y : x)).toBe(
        'REPRESENTATIVE_MATTER_PENDING',
      );
      await a
        .http(
          'post',
          `/board/representatives/matters/${(won.body as MatterBody).id}/withdraw`,
          by.token,
        )
        .expect(200);
    }
  });

  it('approved after the owner left the building: not applied, nobody replaced', async () => {
    const before = await sittingIn('A');
    const raised = await raise({
      action: 'appoint',
      building: 'A',
      accountId: o(6).id,
    });
    await a.moveOut(s.c, o(6).unitId, o(6));
    expect(await carry(raised.id)).toMatchObject({
      status: 'approved',
      decision: { effect: 'not_applied', effectReason: 'not_an_owner' },
    });
    expect(await sittingIn('A')).toEqual(before);
  });

  it('the board ends a term by a matter; it also ends when they no longer own a unit there, and their erasure clears their words', async () => {
    const [sitting] = await sittingIn('A');
    const ending = await raise({ action: 'end', representativeId: sitting.id });
    expect(ending).toMatchObject({ action: 'end', building: 'A' });
    expect(await carry(ending.id)).toMatchObject({
      decision: { effect: 'applied' },
    });
    expect(
      (await representatives()).find((r) => r.id === sitting.id),
    ).toMatchObject({ endReason: 'ended' });
    expect(
      code(
        await raiseRaw(o(0), {
          action: 'end',
          representativeId: sitting.id,
        }).expect(409),
      ),
    ).toBe('REPRESENTATIVE_ENDED');

    const [rep] = await appoint(o(4).id);
    // A co-owner of o(7)'s unit: not its primary, so their account may go.
    const writer = await a.owner(s.c, o(7).unitId);
    await write(writer, rep.id, 'Erase me later.').expect(201);
    await eraseNow(h, s.c, writer.id);
    const thread = (
      (
        await a
          .http('get', '/me/representation/threads', o(4).token)
          .expect(200)
      ).body as { data: { id: string }[] }
    ).data[0];
    const messages = (
      await a
        .http(
          'get',
          `/me/representation/threads/${thread.id}/messages`,
          o(4).token,
        )
        .expect(200)
    ).body as { data: { body: string | null }[] };
    expect(messages.data.map((m) => m.body)).toContain(null);
    await a.moveOut(s.c, o(4).unitId, o(4));
    expect(
      (await representatives()).find((r) => r.id === rep.id),
    ).toMatchObject({ endReason: 'no_longer_owner' });
  });
});
