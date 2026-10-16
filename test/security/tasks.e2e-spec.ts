import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

interface TaskBody {
  id: string;
  kind: string;
  title: string | null;
  unit: { unitId: string; unitCode: string; building: string | null } | null;
  post: { gateId: string | null } | null;
  status: string;
  outcome: string | null;
  resultNote: string | null;
  photos: { url: string }[];
  carried: boolean;
  assignee: { id: string } | null;
  takenBy: { id: string; firstName?: string | null } | null;
}

/**
 * ADR 0050: the management gives guards tasks — a closed unit to inspect,
 * or one in its own words — for a guard, a gate or a zone. A guard on
 * shift takes one, the first wins, and completes it with an outcome; an
 * inspection needs a photo and its outcome is told to the unit's primary.
 * At a shift's end the tasks its guard had move to the shift's post.
 */
describe('Guard tasks', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Tasks Court');
    supervisor = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const create = (body: Record<string, unknown>) =>
    x.http('post', '/staff/security/tasks', supervisor.token, body);
  const made = async (body: Record<string, unknown>) =>
    (await create(body).expect(201)).body as TaskBody;
  const told = async (accountId: string, taskId: string) =>
    (await x.notifications(s.c, accountId))
      .filter((n) => n.targetId === taskId)
      .map((n) => ({ kind: n.kind, params: n.params }));

  it('a gate’s task: the guards on shift there are told; one takes it, first wins; the taker completes it', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const here = await x.guard(s.c);
    const also = await x.guard(s.c);
    const elsewhere = await x.guard(s.c);
    await x.start(here, { gateId });
    await x.start(also, { gateId });
    await x.start(elsewhere, { gateId: (await x.g.gate(s.c)).id });
    const task = await made({
      kind: 'custom',
      title: 'Check the barrier arm',
      details: 'It drops slowly',
      gateId,
    });
    expect(task).toMatchObject({
      status: 'open',
      post: { gateId },
      assignee: null,
      unit: null,
    });
    for (const g of [here, also])
      expect(await told(g.id, task.id)).toEqual([
        { kind: 'guard_task.assigned', params: { taskKind: 'custom' } },
      ]);
    expect(await told(elsewhere.id, task.id)).toEqual([]);
    expect(
      code(await x.http('get', `/gate/tasks/${task.id}`, elsewhere.token)),
    ).toEqual({ status: 404, code: 'GUARD_TASK_NOT_FOUND' });

    const taken = await x
      .http('post', `/gate/tasks/${task.id}/take`, here.token)
      .expect(200);
    expect(taken.body).toMatchObject({
      status: 'in_progress',
      takenBy: { id: here.id, firstName: expect.any(String) as string },
    });
    expect(
      code(await x.http('post', `/gate/tasks/${task.id}/take`, also.token)),
    ).toEqual({ status: 409, code: 'GUARD_TASK_ALREADY_TAKEN' });
    expect(
      code(
        await x.http('post', `/gate/tasks/${task.id}/complete`, also.token, {
          outcome: 'done',
        }),
      ),
    ).toEqual({ status: 403, code: 'GUARD_TASK_NOT_TAKER' });
    const wrong = await x.http(
      'post',
      `/gate/tasks/${task.id}/complete`,
      here.token,
      { outcome: 'all_clear' },
    );
    expect(fields(wrong)).toEqual([
      {
        field: 'outcome',
        code: 'INVALID_VALUE',
        params: { allowed: ['done'] },
      },
    ]);
    const done = await x
      .http('post', `/gate/tasks/${task.id}/complete`, here.token, {
        outcome: 'done',
        note: 'Oiled the hinge',
      })
      .expect(200);
    expect(done.body).toMatchObject({
      status: 'done',
      outcome: 'done',
      resultNote: 'Oiled the hinge',
    });
    expect(
      code(
        await x.http('post', `/gate/tasks/${task.id}/complete`, here.token, {
          outcome: 'done',
        }),
      ),
    ).toEqual({ status: 409, code: 'GUARD_TASK_CLOSED' });
    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'guard_task.completed',
      targetId: task.id,
    });
    expect(entry.metadata).toEqual({ outcome: 'done', photos: 0, note: true });
    for (const g of [here, also, elsewhere]) await x.endRaw(g).expect(200);
  });

  it('a closed unit’s inspection: a photo needed; the primary is told the outcome’s code, never the photo', async () => {
    const open = await x.http(
      'post',
      '/staff/security/tasks',
      supervisor.token,
      {
        kind: 'closed_unit_inspection',
        unitId: s.home.id,
        guardId: (await x.guard(s.c)).id,
      },
    );
    expect(fields(open)).toEqual([
      { field: 'unitId', code: 'UNIT_NOT_CLOSED' },
    ]);
    await x
      .http('post', `/units/${s.home.id}/closed-mode`, s.alice.token, {
        closed: true,
      })
      .expect(204);
    const guard = await x.guard(s.c);
    const task = await made({
      kind: 'closed_unit_inspection',
      unitId: s.home.id,
      guardId: guard.id,
      details: 'Check the windows',
    });
    expect(task.unit).toMatchObject({ unitId: s.home.id });
    expect(Object.keys(task.unit!).sort()).toEqual([
      'building',
      'unitCode',
      'unitId',
    ]);
    expect(await told(guard.id, task.id)).toEqual([
      {
        kind: 'guard_task.assigned',
        params: { taskKind: 'closed_unit_inspection' },
      },
    ]);
    // Off shift, a guard takes nothing.
    expect(
      code(await x.http('post', `/gate/tasks/${task.id}/take`, guard.token)),
    ).toEqual({ status: 403, code: 'NO_OPEN_SHIFT' });
    const gateId = (await x.g.gate(s.c)).id;
    await x.start(guard, { gateId });
    await x
      .http('post', `/gate/tasks/${task.id}/take`, guard.token)
      .expect(200);
    const without = await x.http(
      'post',
      `/gate/tasks/${task.id}/complete`,
      guard.token,
      { outcome: 'issue_found' },
    );
    expect(fields(without)).toEqual([
      { field: 'photoFileIds', code: 'FIELD_REQUIRED' },
    ]);
    const photo = await x.files.ready(guard.token, 'guard_task_photo');
    const done = (
      await x
        .http('post', `/gate/tasks/${task.id}/complete`, guard.token, {
          outcome: 'issue_found',
          note: 'A window is open',
          photoFileIds: [photo],
        })
        .expect(200)
    ).body as TaskBody;
    expect(done.photos).toHaveLength(1);
    expect(await told(s.alice.id, s.home.id)).toEqual([
      { kind: 'guard_task.unit_inspected', params: { outcome: 'issue_found' } },
    ]);
    const file = await x.inTx(s.c, (tx) =>
      tx.storedFile.findUniqueOrThrow({ where: { id: photo } }),
    );
    expect(file.ownerAccountId).toBeNull();
    const staff = (
      await x
        .http('get', `/staff/security/tasks/${task.id}`, supervisor.token)
        .expect(200)
    ).body as TaskBody & { createdBy: { id: string } };
    expect(staff.photos).toHaveLength(1);
    expect(staff.createdBy.id).toBe(supervisor.id);
    await x.endRaw(guard).expect(200);
    await x
      .http('post', `/units/${s.home.id}/closed-mode`, s.alice.token, {
        closed: false,
      })
      .expect(204);
  });

  it('at a shift’s end, the tasks its guard had move to the post, open again; the handover lists them', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const leaving = await x.guard(s.c);
    const next = await x.guard(s.c);
    const mine = await made({
      kind: 'custom',
      title: 'Mine',
      guardId: leaving.id,
    });
    const shift = await x.start(leaving, { gateId });
    const posted = await made({ kind: 'custom', title: 'The gate’s', gateId });
    await x
      .http('post', `/gate/tasks/${posted.id}/take`, leaving.token)
      .expect(200);
    await x.endRaw(leaving).expect(200);
    for (const id of [mine.id, posted.id]) {
      const row = await x.inTx(s.c, (tx) =>
        tx.guardTask.findUniqueOrThrow({ where: { id } }),
      );
      expect(row).toMatchObject({
        status: 'open',
        assigneeId: null,
        gateId,
        takenById: null,
        carriedFromShiftId: shift.id,
      });
    }
    await x.start(next, { gateId });
    const [handover] = (
      (await x.http('get', '/gate/handovers/pending', next.token).expect(200))
        .body as { data: { carriedTaskIds: string[] }[] }
    ).data;
    expect([...handover.carriedTaskIds].sort()).toEqual(
      [mine.id, posted.id].sort(),
    );
    const read = (
      await x.http('get', `/gate/tasks/${mine.id}`, next.token).expect(200)
    ).body as TaskBody;
    expect(read).toMatchObject({ carried: true, status: 'open' });
    // The one who left sees it no more.
    expect(
      code(await x.http('get', `/gate/tasks/${mine.id}`, leaving.token)),
    ).toEqual({ status: 404, code: 'GUARD_TASK_NOT_FOUND' });
    await x.endRaw(next).expect(200);
  });

  it('the management cancels a task while it is not over; a cancelled one is taken by nobody', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    const task = await made({ kind: 'custom', title: 'Spare', gateId });
    const cancelled = await x
      .http(
        'post',
        `/staff/security/tasks/${task.id}/cancel`,
        supervisor.token,
        {
          reasonCode: 'no_longer_needed',
        },
      )
      .expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'cancelled',
      cancelReason: 'no_longer_needed',
    });
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/tasks/${task.id}/cancel`,
          supervisor.token,
          {
            reasonCode: 'other',
          },
        ),
      ),
    ).toEqual({ status: 409, code: 'GUARD_TASK_CLOSED' });
    expect(
      code(await x.http('post', `/gate/tasks/${task.id}/take`, guard.token)),
    ).toEqual({ status: 409, code: 'GUARD_TASK_CLOSED' });
    await x.endRaw(guard).expect(200);
  });

  it('what a task needs: a custom one a title, an inspection a unit; exactly one assignee; a due time ahead', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    expect(fields(await create({ kind: 'custom', gateId }))).toEqual([
      { field: 'title', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      fields(
        await create({ kind: 'closed_unit_inspection', title: 'X', gateId }),
      ),
    ).toEqual([
      { field: 'title', code: 'FIELD_NOT_ALLOWED' },
      { field: 'unitId', code: 'FIELD_REQUIRED' },
    ]);
    expect(fields(await create({ kind: 'custom', title: 'X' }))).toEqual([
      { field: 'guardId', code: 'FIELD_REQUIRED' },
    ]);
    expect(
      fields(
        await create({
          kind: 'custom',
          title: 'X',
          gateId,
          guardId: (await x.guard(s.c)).id,
        }),
      ),
    ).toEqual([{ field: 'gateId', code: 'FIELD_NOT_ALLOWED' }]);
    expect(
      fields(
        await create({
          kind: 'custom',
          title: 'X',
          gateId,
          dueAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    ).toEqual([{ field: 'dueAt', code: 'INVALID_VALUE' }]);
  });
});
