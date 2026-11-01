import { addDays } from '../../src/core/common/slots/day-slots';
import { fieldTeamHelpers } from '../setup/field-team';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { today } from '../setup/compound-clock';
import type { Who } from '../setup/safety';

interface Instruction {
  id: string;
  audience: string;
  recipients: number;
  acknowledged: number;
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

/**
 * ADR 0078: the field team sends the technicians instructions — the
 * guards' instructions (ADR 0050, 0056) with the `technicians` audience.
 * They reach every active technician at the send and anyone going on duty
 * while live; each acknowledges once. Guards are never reached, and the
 * guards' routes never see them.
 */
describe('Instructions to the technicians', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof fieldTeamHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof fieldTeamHelpers>['setUp']>>;
  let tech: Who;
  let guard: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = fieldTeamHelpers(h);
    s = await x.setUp('Field Instructions Court');
    tech = await x.technician(s.c);
    guard = await x.guard(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const send = (body: object) =>
    x.http('post', '/staff/field-team/instructions', s.boss.token, {
      title: 'Ladders',
      body: 'Two people for every ladder over three metres.',
      ...body,
    });

  const recipientsOf = async (id: string) =>
    (
      await x.v.inTx(s.c, (tx) =>
        tx.guardInstructionRecipient.findMany({ where: { instructionId: id } }),
      )
    ).map((r) => ({ accountId: r.accountId, via: r.addedVia }));

  it('reaches every technician, never a guard; told by the technicians’ kinds; acknowledged once', async () => {
    const res = await send({}).expect(201);
    const i = res.body as Instruction;
    expect(i.audience).toBe('technicians');
    const reached = await recipientsOf(i.id);
    expect(reached).toContainEqual({ accountId: tech.id, via: 'send' });
    expect(reached.map((r) => r.accountId)).not.toContain(guard.id);
    expect(await x.told(s.c, tech.id, i.id)).toEqual([
      { kind: 'technician_instruction.issued', params: {} },
    ]);
    expect(await x.told(s.c, guard.id, i.id)).toEqual([]);

    const urgent = (await send({ urgent: true }).expect(201))
      .body as Instruction;
    expect(await x.told(s.c, tech.id, urgent.id)).toEqual([
      { kind: 'technician_instruction.urgent', params: {} },
    ]);

    const mine = await x
      .http('get', '/maintenance/instructions?status=pending', tech.token)
      .expect(200);
    expect(
      (mine.body as { data: { id: string }[] }).data.map((m) => m.id),
    ).toEqual(expect.arrayContaining([i.id, urgent.id]));
    await x
      .http('post', `/maintenance/instructions/${i.id}/acknowledge`, tech.token)
      .expect(200);
    await x
      .http('post', `/maintenance/instructions/${i.id}/acknowledge`, tech.token)
      .expect(200);
    const detail = await x
      .http('get', `/staff/field-team/instructions/${i.id}`, s.boss.token)
      .expect(200);
    expect(detail.body).toMatchObject({ acknowledged: 1 });
  });

  it('the guards’ routes never see the technicians’ instructions, nor these the guards’', async () => {
    const mine = (await send({}).expect(201)).body as Instruction;
    const list = await x
      .http('get', '/staff/security/instructions', s.manager.token)
      .expect(200);
    expect(
      (list.body as { data: { id: string }[] }).data.map((r) => r.id),
    ).not.toContain(mine.id);
    expect(
      code(
        await x.http(
          'get',
          `/staff/security/instructions/${mine.id}`,
          s.manager.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'GUARD_INSTRUCTION_NOT_FOUND' });
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/instructions/${mine.id}/archive`,
          s.manager.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'GUARD_INSTRUCTION_NOT_FOUND' });
    const theirs = (
      await x
        .http('post', '/staff/security/instructions', s.manager.token, {
          title: 'Gate',
          body: 'Close the side gate at ten.',
          audience: 'all',
        })
        .expect(201)
    ).body as Instruction;
    expect(
      code(
        await x.http(
          'get',
          `/staff/field-team/instructions/${theirs.id}`,
          s.boss.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'GUARD_INSTRUCTION_NOT_FOUND' });
    expect(await recipientsOf(theirs.id)).not.toContainEqual(
      expect.objectContaining({ accountId: tech.id }),
    );
  });

  it('a guards’ zone instruction never reaches a technician scheduled in that zone', async () => {
    const zone = Object.values(await x.places(s.manager))[0];
    const there = await x.technician(s.c);
    await x.dutySlot(s.c, there.id, -60, 60, zone.id);
    const sent = (
      await x
        .http('post', '/staff/security/instructions', s.manager.token, {
          title: 'Zone',
          body: 'Check the pool fence.',
          audience: 'zone',
          zoneId: zone.id,
        })
        .expect(201)
    ).body as Instruction;
    expect(await recipientsOf(sent.id)).not.toContainEqual(
      expect.objectContaining({ accountId: there.id }),
    );
  });

  it('a technician going on duty while it is live is reached and told once; one to come is told on a day it holds', async () => {
    const live = (await send({}).expect(201)).body as Instruction;
    const later = (await send({ validFrom: addDays(today(), 2) }).expect(201))
      .body as Instruction;
    const archived = (await send({}).expect(201)).body as Instruction;
    await x
      .http(
        'post',
        `/staff/field-team/instructions/${archived.id}/archive`,
        s.boss.token,
      )
      .expect(200);
    const newcomer = await x.technician(s.c);
    await x.onDuty(newcomer);
    expect(await recipientsOf(live.id)).toContainEqual({
      accountId: newcomer.id,
      via: 'on_duty',
    });
    expect(await x.told(s.c, newcomer.id, live.id)).toEqual([
      { kind: 'technician_instruction.issued', params: {} },
    ]);
    // Not yet valid: reached, silent until a day it holds.
    expect(await recipientsOf(later.id)).toContainEqual({
      accountId: newcomer.id,
      via: 'on_duty',
    });
    expect(await x.told(s.c, newcomer.id, later.id)).toEqual([]);
    // Archived: it reaches nobody new.
    expect(await recipientsOf(archived.id)).not.toContainEqual(
      expect.objectContaining({ accountId: newcomer.id }),
    );
    // Off and on again: told once.
    await x.offDuty(newcomer);
    await x.onDuty(newcomer);
    expect(await x.told(s.c, newcomer.id, live.id)).toHaveLength(1);
    await x.offDuty(newcomer);
  });
});
