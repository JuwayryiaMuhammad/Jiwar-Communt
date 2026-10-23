import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  governanceHelpers,
  lapse,
  type StaffTermBody,
  type Who,
} from '../setup/governance';

/**
 * ADR 0051: the owners' board — who may sit, appointing one when none
 * sits, its seats and offices, and a sitting member's derived
 * `governance.board`, gone on the next request once the seat or the term
 * is.
 */
describe('Governance — the board', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(6);
  }, 180_000);

  afterAll(() => h.close());

  const [a, b, c, d, e2, f] = [0, 1, 2, 3, 4, 5].map((i) => () => s.owners[i]);
  /** A tenant of a unit its landlord rents out. */
  async function aTenant(): Promise<Who> {
    const unit = await g.unit(s.c, 'B');
    await g.landlord(s.c, unit.id);
    return g.tenant(s.c, unit.id);
  }
  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (x) => [x.field, x.code],
    );

  it('before any board: owners see none, a tenant and a family member find nothing, the manager sees no term', async () => {
    const tenant = await aTenant();
    const family = await g.family(s.c, a().unitId, a());
    const res = await g.http('get', '/governance/board', a().token).expect(200);
    expect(res.body).toEqual({ board: null });
    const t = await g
      .http('get', '/governance/board', tenant.token)
      .expect(404);
    expect(code(t)).toBe('GOVERNANCE_NOT_AVAILABLE');
    // A family member's role does not hold governance.read at all.
    await g.http('get', '/governance/board', family.token).expect(403);
    expect(await g.staffBoard(s.manager)).toBeNull();
  });

  it('only owners are appointed, 3 to `seats` of them, each once, one chair', async () => {
    const tenant = await aTenant();
    const post = (body: object) =>
      g.http('post', '/staff/governance/board/appoint', s.manager.token, {
        seats: 5,
        endsAt: g.inAYear(),
        ...body,
      });
    const seat = (w: Who, role = 'member') => ({ accountId: w.id, role });
    const notOwner = await post({
      members: [seat(a(), 'chair'), seat(b()), seat(tenant)],
    }).expect(400);
    expect(fields(notOwner)).toEqual([
      ['members.2.accountId', 'OWNER_NOT_ELIGIBLE'],
    ]);
    const twoChairs = await post({
      members: [seat(a(), 'chair'), seat(b(), 'chair'), seat(c())],
    }).expect(400);
    expect(fields(twoChairs)).toEqual([['members', 'DUPLICATE_VALUE']]);
    const tooFew = await post({ members: [seat(a()), seat(b())] }).expect(400);
    expect(fields(tooFew)).toEqual([['members', 'BOARD_SIZE']]);
    const tooSoon = await post({
      // eslint-disable-next-line no-restricted-syntax -- a real 24 h: the term's length is measured in ms
      endsAt: new Date(Date.now() + 86_400_000).toISOString(),
      members: [seat(a()), seat(b()), seat(c())],
    }).expect(400);
    expect(fields(tooSoon)).toEqual([['endsAt', 'INVALID_VALUE']]);
  });

  let term: StaffTermBody;

  it('the manager appoints the first board: its members are told, and hold governance.board from the next request', async () => {
    expect(await g.permissionsOf(a())).not.toContain('governance.board');
    term = await g.appoint(s.manager, [a(), b(), c()], { seats: 5 });
    expect(term).toMatchObject({
      source: 'appointed',
      seats: 5,
      status: 'current',
      endedAt: null,
    });
    expect(term.members.map((m) => [m.accountId, m.role])).toEqual([
      [a().id, 'chair'],
      [b().id, 'member'],
      [c().id, 'member'],
    ]);
    for (const m of [a(), b(), c()]) {
      expect(await g.permissionsOf(m)).toContain('governance.board');
      const told = await g.notifications(s.c, m.id, 'governance_board.seat');
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ targetId: term.id });
    }
    expect(await g.permissionsOf(d())).not.toContain('governance.board');
    // Owners see the board by name and role, never an account id.
    const now = await g.http('get', '/governance/board', d().token).expect(200);
    const board = (now.body as { board: Record<string, unknown> }).board;
    expect(board).toMatchObject({ id: term.id, status: 'current' });
    expect(JSON.stringify(board)).not.toContain(a().id);
  });

  it('a board is never appointed over a sitting one', async () => {
    const res = await g
      .http('post', '/staff/governance/board/appoint', s.manager.token, {
        seats: 3,
        endsAt: g.inAYear(),
        members: [d(), e2(), f()].map((m) => ({
          accountId: m.id,
          role: 'member',
        })),
      })
      .expect(409);
    expect(code(res)).toBe('BOARD_SITTING');
  });

  it('a vacant seat is filled; an office held is refused; seats run out', async () => {
    const add = (w: Who, role: string) =>
      g.http('post', '/staff/governance/board/members', s.manager.token, {
        accountId: w.id,
        role,
      });
    expect(code(await add(d(), 'chair').expect(409))).toBe(
      'BOARD_OFFICE_TAKEN',
    );
    expect(code(await add(a(), 'member').expect(409))).toBe(
      'BOARD_ALREADY_SEATED',
    );
    await add(d(), 'treasurer').expect(201);
    await add(e2(), 'secretary').expect(201);
    expect(code(await add(f(), 'member').expect(409))).toBe('BOARD_SEATS_FULL');
    expect(await g.permissionsOf(d())).toContain('governance.board');
  });

  it('a role changes while seated, never into an office another holds', async () => {
    const board = (await g.staffBoard(s.manager))!;
    const seatOf = (w: Who) => board.members.find((m) => m.accountId === w.id)!;
    const change = (w: Who, role: string) =>
      g.http(
        'patch',
        `/staff/governance/board/members/${seatOf(w).id}`,
        s.manager.token,
        {
          role,
        },
      );
    expect(code(await change(b(), 'chair').expect(409))).toBe(
      'BOARD_OFFICE_TAKEN',
    );
    await change(a(), 'member').expect(200);
    const res = await change(b(), 'chair').expect(200);
    const after = res.body as StaffTermBody;
    expect(after.members.find((m) => m.accountId === b().id)!.role).toBe(
      'chair',
    );
  });

  it('an ended seat holds nothing on the next request, and frees its place', async () => {
    const board = (await g.staffBoard(s.manager))!;
    const seat = board.members.find((m) => m.accountId === c().id)!;
    const end = (reasonCode?: string) =>
      g.http(
        'post',
        `/staff/governance/board/members/${seat.id}/end`,
        s.manager.token,
        {
          ...(reasonCode ? { reasonCode } : {}),
        },
      );
    // The code is required by the body's shape: a field error.
    expect(code(await end().expect(400))).toBe('VALIDATION_FAILED');
    expect(code(await end('account_closed').expect(400))).toBe(
      'VALIDATION_FAILED',
    );
    const res = await end('resigned').expect(200);
    expect(
      (res.body as StaffTermBody).members.find((m) => m.id === seat.id),
    ).toMatchObject({ endReason: 'resigned' });
    expect(await g.permissionsOf(c())).not.toContain('governance.board');
    expect(code(await end('resigned').expect(404))).toBe(
      'BOARD_MEMBER_NOT_FOUND',
    );
    // The owners see who sits: not the one who left.
    const now = await g.http('get', '/governance/board', f().token).expect(200);
    const ids = (
      now.body as { board: { members: { id: string }[] } }
    ).board.members.map((m) => m.id);
    expect(ids).not.toContain(seat.id);
    await g
      .http('post', '/staff/governance/board/members', s.manager.token, {
        accountId: f().id,
        role: 'member',
      })
      .expect(201);
  });

  it('a lapsed term holds nothing; the manager appoints the next board, which ends it (`replaced`)', async () => {
    await lapse(term.id);
    expect(await g.permissionsOf(b())).not.toContain('governance.board');
    expect(
      (await g.http('get', '/governance/board', d().token).expect(200)).body,
    ).toEqual({ board: null });
    expect(await g.staffBoard(s.manager)).toMatchObject({
      id: term.id,
      status: 'lapsed',
    });
    const add = await g
      .http('post', '/staff/governance/board/members', s.manager.token, {
        accountId: c().id,
        role: 'member',
      })
      .expect(409);
    expect(code(add)).toBe('BOARD_NOT_SITTING');

    const next = await g.appoint(s.manager, [d(), e2(), f()]);
    expect(next.status).toBe('current');
    const terms = await g
      .http('get', '/staff/governance/board/terms', s.manager.token)
      .expect(200);
    const [newest, older] = (terms.body as { data: StaffTermBody[] }).data;
    expect(newest.id).toBe(next.id);
    expect(older).toMatchObject({
      id: term.id,
      status: 'ended',
      endReason: 'replaced',
    });
    expect(await g.permissionsOf(d())).toContain('governance.board');
    expect(await g.permissionsOf(b())).not.toContain('governance.board');
    // Owners read the history, everyone who sat in a past term.
    const history = await g
      .http('get', '/governance/board/terms', a().token)
      .expect(200);
    expect(
      (history.body as { data: { members: unknown[] }[] }).data[1].members,
    ).toHaveLength(6);
  });

  it('the owners picker finds owners by name or unit code, never a tenant', async () => {
    const all = await g
      .http('get', '/staff/governance/owners', s.manager.token)
      .expect(200);
    const ids = (all.body as { data: { accountId: string }[] }).data.map(
      (o) => o.accountId,
    );
    for (const o of s.owners) expect(ids).toContain(o.id);
    const unitCode = (
      await g.x.asManager(s.c, () =>
        g.x.prisma.tenant.unit.findUniqueOrThrow({ where: { id: a().unitId } }),
      )
    ).code;
    const found = await g
      .http(
        'get',
        `/staff/governance/owners?search=${encodeURIComponent(unitCode.toLowerCase())}`,
        s.manager.token,
      )
      .expect(200);
    expect(
      (found.body as { data: { accountId: string; unitCodes: string[] }[] })
        .data,
    ).toEqual([
      expect.objectContaining({ accountId: a().id, unitCodes: [unitCode] }),
    ]);
  });

  it('a seat is no role’s: the guard asks the seat, a sitting member’s role stays the resident’s', async () => {
    const me = await g.http('get', '/me', d().token).expect(200);
    expect((me.body as { role: { key: string } }).role.key).toBe('resident');
  });
});
