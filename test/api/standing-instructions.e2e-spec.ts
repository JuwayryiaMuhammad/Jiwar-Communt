import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { eraseNow } from '../setup/erasure';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const LISTED = [
  'action',
  'createdAt',
  'createdBy',
  'createdBy.fullName',
  'createdBy.id',
  'description',
  'effectiveAction',
  'id',
];

/**
 * A household's standing instructions (ADR 0043): who writes and deletes
 * them, what the guard sees of them on a waiting request, and the decision
 * the guard takes by one — the entry then logged as always.
 */
describe('API v0 — standing instructions (ADR 0043)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const status = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const path = (unitId: string) => `/units/${unitId}/standing-instructions`;
  const add = (token: string, unitId: string, body: object) =>
    call(w, 'POST', path(unitId), { token, body });
  const setAlways = (allowAlwaysAllow: boolean) =>
    call(w, 'PATCH', '/settings', {
      token: w.a.tokens.manager,
      body: { allowAlwaysAllow },
    }).expect(200);
  const guard = () => w.a.tokens.guard;
  const ask = async (unitCode: string, kind = 'uninvited_visitor') =>
    (
      await call(w, 'POST', '/gate/approval-requests', {
        token: guard(),
        body: { kind, unitCode },
      }).expect(201)
    ).body as {
      id: string;
      standingInstructions: {
        id: string;
        description: string;
        action: string;
      }[];
    };
  const apply = (requestId: string, instructionId: string) =>
    call(w, 'POST', `/gate/approval-requests/${requestId}/apply-instruction`, {
      token: guard(),
      body: { instructionId },
    });

  /** A unit with its primary and a family member who may invite. */
  async function household() {
    const unit = await w.helpers.unit(w.a);
    const primary = await w.helpers.resident(w.a, [unit.id]);
    const member = await w.helpers.joinFamily(w.a, unit.id, primary);
    return {
      unit,
      primary,
      member,
      primaryToken: await w.tokenFor(w.a, primary.id, 'resident'),
      memberToken: await w.tokenFor(w.a, member.id, 'family'),
    };
  }

  it('inviters write and read them; the author or the primary deletes', async () => {
    const x = await household();
    const made = await add(x.memberToken, x.unit.id, {
      description: '  My mother,   Hoda  ',
      action: 'always_allow',
    }).expect(201);
    expect(keyPaths(made.body)).toEqual(LISTED);
    expect(made.body).toMatchObject({
      description: 'My mother, Hoda',
      action: 'always_allow',
      effectiveAction: 'always_allow',
      createdBy: { id: x.member.id },
    });
    const second = await add(x.primaryToken, x.unit.id, {
      description: 'Ahmed the driver',
      action: 'call_first',
    }).expect(201);
    const list = await call(w, 'GET', path(x.unit.id), {
      token: x.memberToken,
    }).expect(200);
    expect(keyPaths(list.body)).toEqual(listKeys(LISTED));
    expect(
      (list.body as { data: { id: string }[] }).data.map((i) => i.id),
    ).toEqual([
      (made.body as { id: string }).id,
      (second.body as { id: string }).id,
    ]);

    // Another unit's resident: no place there.
    expect(
      status(
        await call(w, 'GET', path(x.unit.id), { token: w.a.tokens.owner }),
      ),
    ).toEqual({ status: 404, code: 'UNIT_NOT_FOUND' });
    // The member may not delete the primary's; the primary may delete any.
    const del = (token: string, id: string) =>
      call(w, 'DELETE', `${path(x.unit.id)}/${id}`, { token });
    expect(
      status(await del(x.memberToken, (second.body as { id: string }).id)),
    ).toEqual({ status: 403, code: 'FORBIDDEN' });
    await del(x.primaryToken, (made.body as { id: string }).id).expect(204);
    expect(
      status(await del(x.primaryToken, (made.body as { id: string }).id)),
    ).toEqual({ status: 404, code: 'STANDING_INSTRUCTION_NOT_FOUND' });
    // Another unit's instruction through this unit's path: not found.
    const y = await household();
    const theirs = await add(y.primaryToken, y.unit.id, {
      description: 'Not yours',
      action: 'never_allow',
    }).expect(201);
    expect(
      status(await del(x.primaryToken, (theirs.body as { id: string }).id)),
    ).toEqual({ status: 404, code: 'STANDING_INSTRUCTION_NOT_FOUND' });

    // A member without visitors_invite may not.
    await call(
      w,
      'POST',
      `/household/members/${x.member.memberId}/permissions/revoke`,
      {
        token: x.primaryToken,
        body: {
          permission: 'visitors_invite',
          reasonCode: 'no_longer_needed',
          reason: 'Test',
        },
      },
    ).expect(204);
    expect(
      status(
        await add(x.memberToken, x.unit.id, {
          description: 'Anyone',
          action: 'call_first',
        }),
      ),
    ).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  it('a description is 1–140 characters; a unit has 20 at most', async () => {
    const x = await household();
    for (const description of ['   ', 'x'.repeat(141)])
      expect(
        err(
          await add(x.primaryToken, x.unit.id, {
            description,
            action: 'call_first',
          }),
        ).fields,
      ).toEqual([
        {
          field: 'description',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 140 },
        },
      ]);
    for (let i = 0; i < 20; i++)
      await add(x.primaryToken, x.unit.id, {
        description: `Regular ${i}`,
        action: 'call_first',
      }).expect(201);
    const full = await add(x.primaryToken, x.unit.id, {
      description: 'One too many',
      action: 'call_first',
    });
    expect(status(full)).toEqual({
      status: 409,
      code: 'STANDING_INSTRUCTION_LIMIT_REACHED',
    });
    expect(err(full).params).toEqual({ max: 20 });
  });

  it('the guard sees them on a waiting request and decides by one; the entry is logged', async () => {
    const x = await household();
    const mk = async (description: string, action: string) =>
      (
        (
          await add(x.primaryToken, x.unit.id, { description, action }).expect(
            201,
          )
        ).body as { id: string }
      ).id;
    const always = await mk('Mother Hoda', 'always_allow');
    const never = await mk('The ex', 'never_allow');
    const call1 = await mk('Driver', 'call_first');
    const parcel = await mk('Pharmacy', 'leave_at_gate');

    const asked = await ask(x.unit.code);
    expect(asked.standingInstructions).toEqual([
      { id: always, description: 'Mother Hoda', action: 'always_allow' },
      { id: never, description: 'The ex', action: 'never_allow' },
      { id: call1, description: 'Driver', action: 'call_first' },
      { id: parcel, description: 'Pharmacy', action: 'leave_at_gate' },
    ]);
    // Nothing about who wrote them.
    expect(JSON.stringify(asked)).not.toContain(x.primary.id);

    // call_first decides nothing: the household answers.
    expect(status(await apply(asked.id, call1))).toEqual({
      status: 409,
      code: 'STANDING_INSTRUCTION_CALL_FIRST',
    });
    const let_in = await apply(asked.id, always).expect(200);
    expect(let_in.body).toMatchObject({
      status: 'approved',
      decisionSource: 'standing_instruction',
      standingInstructions: [],
    });
    const entry = await call(w, 'POST', '/gate/entries', {
      token: guard(),
      body: {
        subjectType: 'gate_request',
        subjectId: asked.id,
        direction: 'in',
      },
    }).expect(201);
    expect(entry.body).toMatchObject({ method: 'approval', direction: 'in' });
    // Decided: nothing more to apply.
    expect(status(await apply(asked.id, never))).toEqual({
      status: 409,
      code: 'GATE_REQUEST_DECIDED',
    });

    const turned = await ask(x.unit.code);
    expect((await apply(turned.id, never).expect(200)).body).toMatchObject({
      status: 'denied',
    });
    const dropped = await ask(x.unit.code, 'delivery');
    expect((await apply(dropped.id, parcel).expect(200)).body).toMatchObject({
      status: 'leave_at_gate',
    });
    // Another unit's instruction is not this request's.
    const y = await household();
    const theirs = await add(y.primaryToken, y.unit.id, {
      description: 'Theirs',
      action: 'always_allow',
    }).expect(201);
    const other = await ask(x.unit.code);
    expect(
      status(await apply(other.id, (theirs.body as { id: string }).id)),
    ).toEqual({ status: 404, code: 'STANDING_INSTRUCTION_NOT_FOUND' });
  });

  it('allowAlwaysAllow off: none is written, the guard reads call_first', async () => {
    const x = await household();
    const made = await add(x.primaryToken, x.unit.id, {
      description: 'Brother Karim',
      action: 'always_allow',
    }).expect(201);
    await setAlways(false);
    try {
      expect(
        status(
          await add(x.primaryToken, x.unit.id, {
            description: 'Sister Mona',
            action: 'always_allow',
          }),
        ),
      ).toEqual({ status: 409, code: 'ALWAYS_ALLOW_DISABLED' });
      const list = await call(w, 'GET', path(x.unit.id), {
        token: x.primaryToken,
      }).expect(200);
      expect((list.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({
          action: 'always_allow',
          effectiveAction: 'call_first',
        }),
      ]);
      const asked = await ask(x.unit.code);
      expect(asked.standingInstructions).toEqual([
        {
          id: (made.body as { id: string }).id,
          description: 'Brother Karim',
          action: 'call_first',
        },
      ]);
      expect(
        status(await apply(asked.id, (made.body as { id: string }).id)),
      ).toEqual({ status: 409, code: 'STANDING_INSTRUCTION_CALL_FIRST' });
    } finally {
      await setAlways(true);
    }
  });

  it('an instruction speaks for the unit while its author may invite; erasure deletes it', async () => {
    const x = await household();
    const made = await add(x.memberToken, x.unit.id, {
      description: 'Cousin Omar',
      action: 'always_allow',
    }).expect(201);
    const id = (made.body as { id: string }).id;
    await call(
      w,
      'POST',
      `/household/members/${x.member.memberId}/permissions/revoke`,
      {
        token: x.primaryToken,
        body: {
          permission: 'visitors_invite',
          reasonCode: 'no_longer_needed',
          reason: 'Test',
        },
      },
    ).expect(204);
    const asked = await ask(x.unit.code);
    expect(asked.standingInstructions).toEqual([]);
    expect(status(await apply(asked.id, id))).toEqual({
      status: 404,
      code: 'STANDING_INSTRUCTION_NOT_FOUND',
    });

    // The author erased: the words go.
    const z = await household();
    await add(z.memberToken, z.unit.id, {
      description: 'Neighbour Laila',
      action: 'call_first',
    }).expect(201);
    await eraseNow(h, w.a, z.member.id);
    const left = await call(w, 'GET', path(z.unit.id), {
      token: z.primaryToken,
    }).expect(200);
    expect((left.body as { data: unknown[] }).data).toEqual([]);
  });
});
