import { dbDate, day, today } from '../setup/compound-clock';
import { newId } from '../../src/core/common/uuid';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

interface StaffBody {
  id: string;
  state: string;
  validFrom: string | null;
  validUntil: string | null;
  recipients: number;
}

/**
 * ADR 0056, instructions with validity: an instruction may hold from a
 * compound day and/or until one, both inclusive, fixed when sent. A guard
 * sees and acknowledges only those valid today; the management sees each
 * one's state. A guard is told once: at the send when it holds that day,
 * else at their first shift start on a day it holds. Days come from the
 * compound's calendar (compound-clock); a day still to come is reached by
 * writing the row as if sent on an earlier day.
 */
describe('Instructions to guards — validity (ADR 0056)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Instruction Days Court');
    supervisor = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const send = (body: Record<string, unknown>) =>
    x.http('post', '/staff/security/instructions', supervisor.token, {
      title: 'Season hours',
      body: 'The north gate closes at 20:00.',
      ...body,
    });
  const sent = async (body: Record<string, unknown>) =>
    (await send(body).expect(201)).body as StaffBody;
  const mine = async (as: Who) =>
    (
      (await x.http('get', '/gate/guard-instructions', as.token).expect(200))
        .body as { data: { id: string }[] }
    ).data.map((i) => i.id);
  const staffList = async (state: string) =>
    (
      (
        await x
          .http(
            'get',
            `/staff/security/instructions?state=${state}&limit=100`,
            supervisor.token,
          )
          .expect(200)
      ).body as { data: StaffBody[] }
    ).data.map((i) => i.id);
  const kinds = async (accountId: string, id: string) =>
    (await x.told(s.c, accountId, id)).map((n) => n.kind);
  const pendingCount = async (as: Who) =>
    (
      (await x.http('get', '/gate/my-work', as.token).expect(200)).body as {
        pendingInstructions: number;
      }
    ).pendingInstructions;
  const recipient = (instructionId: string, accountId: string) =>
    x.inTx(s.c, (tx) =>
      tx.guardInstructionRecipient.findFirst({
        where: { instructionId, accountId },
      }),
    );
  /** An instruction as the send wrote it on an earlier day: the row itself. */
  const written = (r: {
    gateId: string;
    validFrom?: string;
    validUntil?: string;
    urgent?: boolean;
  }) =>
    x.inTx(s.c, async (tx) => {
      const id = newId();
      await tx.guardInstruction.create({
        data: {
          id,
          tenantId: s.c.tenantId,
          title: 'Written earlier',
          body: 'Earlier words',
          urgent: r.urgent ?? false,
          audience: 'gate',
          gateId: r.gateId,
          validFrom: r.validFrom ? dbDate(r.validFrom) : null,
          validUntil: r.validUntil ? dbDate(r.validUntil) : null,
          createdById: supervisor.id,
        },
      });
      return id;
    });

  it('from tomorrow: reached, not told; unseen by the guard, refused to acknowledge; scheduled for the management', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    const i = await sent({
      audience: 'gate',
      gateId,
      validFrom: day(1),
      validUntil: day(3),
    });
    expect(i).toMatchObject({
      state: 'scheduled',
      validFrom: day(1),
      validUntil: day(3),
      recipients: 1,
    });
    expect(await kinds(guard.id, i.id)).toEqual([]);
    expect((await recipient(i.id, guard.id))?.notifiedAt).toBeNull();
    expect(await mine(guard)).not.toContain(i.id);
    expect(await pendingCount(guard)).toBe(0);
    for (const [method, path] of [
      ['get', `/gate/guard-instructions/${i.id}`],
      ['post', `/gate/guard-instructions/${i.id}/acknowledge`],
    ] as const)
      expect(code(await x.http(method, path, guard.token))).toEqual({
        status: 404,
        code: 'GUARD_INSTRUCTION_NOT_FOUND',
      });
    expect(await staffList('scheduled')).toContain(i.id);
    expect(await staffList('live')).not.toContain(i.id);
    await x.endRaw(guard).expect(200);
  });

  it('today to the day after tomorrow: told at the send, seen, acknowledged; live', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId });
    const i = await sent({
      audience: 'gate',
      gateId,
      validFrom: today(),
      validUntil: day(2),
    });
    expect(i.state).toBe('live');
    expect(await kinds(guard.id, i.id)).toEqual(['guard_instruction.issued']);
    expect((await recipient(i.id, guard.id))?.notifiedAt).not.toBeNull();
    expect(await mine(guard)).toContain(i.id);
    expect(await pendingCount(guard)).toBe(1);
    await x
      .http('post', `/gate/guard-instructions/${i.id}/acknowledge`, guard.token)
      .expect(200);
    expect(await pendingCount(guard)).toBe(0);
    // Only today, too: one day is a valid period.
    const oneDay = await sent({
      audience: 'gate',
      gateId,
      validFrom: today(),
      validUntil: today(),
    });
    expect(oneDay.state).toBe('live');
    expect(await kinds(guard.id, oneDay.id)).toEqual([
      'guard_instruction.issued',
    ]);
    expect(await staffList('live')).toEqual(
      expect.arrayContaining([i.id, oneDay.id]),
    );
    await x.endRaw(guard).expect(200);
  });

  it('its first day come: told at the first shift start, once; a newcomer is added silently, told', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    // Sent yesterday from today: the guard was reached then, untold.
    const id = await written({ gateId, validFrom: today(), urgent: true });
    await x.inTx(s.c, (tx) =>
      tx.guardInstructionRecipient.create({
        data: {
          id: newId(),
          tenantId: s.c.tenantId,
          instructionId: id,
          accountId: guard.id,
          addedVia: 'send',
        },
      }),
    );
    expect(await kinds(guard.id, id)).toEqual([]);
    await x.start(guard, { gateId });
    expect(await kinds(guard.id, id)).toEqual(['guard_instruction.urgent']);
    expect(await mine(guard)).toContain(id);
    await x.endRaw(guard).expect(200);
    await x.start(guard, { gateId });
    expect(await kinds(guard.id, id)).toEqual(['guard_instruction.urgent']);
    await x.endRaw(guard).expect(200);

    const newcomer = await x.guard(s.c);
    await x.start(newcomer, { gateId });
    expect(await kinds(newcomer.id, id)).toEqual([]);
    expect(await recipient(id, newcomer.id)).toMatchObject({
      addedVia: 'shift_start',
      notifiedAt: expect.any(Date) as Date,
    });
    expect(await mine(newcomer)).toContain(id);
    await x.endRaw(newcomer).expect(200);
  });

  it('a shift start before its first day: reached, untold; past its last day: not reached, expired', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const guard = await x.guard(s.c);
    const scheduled = (
      await sent({ audience: 'gate', gateId, validFrom: day(1) })
    ).id;
    const over = await written({
      gateId,
      validFrom: day(-3),
      validUntil: day(-1),
    });
    await x.start(guard, { gateId });
    expect(await recipient(scheduled, guard.id)).toMatchObject({
      addedVia: 'shift_start',
      notifiedAt: null,
    });
    expect(await kinds(guard.id, scheduled)).toEqual([]);
    expect(await recipient(over, guard.id)).toBeNull();
    expect(await mine(guard)).not.toContain(scheduled);
    expect(await staffList('expired')).toContain(over);
    expect(await staffList('live')).not.toContain(over);
    const view = (
      await x
        .http('get', `/staff/security/instructions/${over}`, supervisor.token)
        .expect(200)
    ).body as StaffBody;
    expect(view).toMatchObject({
      state: 'expired',
      validFrom: day(-3),
      validUntil: day(-1),
    });
    await x.endRaw(guard).expect(200);
  });

  it('archived wins over every day', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const i = await sent({ audience: 'gate', gateId, validFrom: day(1) });
    await x
      .http(
        'post',
        `/staff/security/instructions/${i.id}/archive`,
        supervisor.token,
      )
      .expect(200);
    expect(await staffList('archived')).toContain(i.id);
    expect(await staffList('scheduled')).not.toContain(i.id);
  });

  it('the days are ordered, and not over before it is sent', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const fields = async (body: Record<string, unknown>) =>
      (
        (await send({ audience: 'gate', gateId, ...body }).expect(400))
          .body as { fields: unknown[] }
      ).fields;
    expect(await fields({ validFrom: day(3), validUntil: day(2) })).toEqual([
      { field: 'validUntil', code: 'ENDS_BEFORE_START' },
    ]);
    expect(await fields({ validUntil: day(-1) })).toEqual([
      {
        field: 'validUntil',
        code: 'DAY_OUT_OF_RANGE',
        params: { min: today() },
      },
    ]);
    // A day in the past to start is allowed: it holds from today.
    expect(
      (await sent({ audience: 'gate', gateId, validFrom: day(-2) })).state,
    ).toBe('live');
  });
});
