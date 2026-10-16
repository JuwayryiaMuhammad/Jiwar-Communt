import { addDays, localDate } from '../../src/core/common/slots/day-slots';
import { auditReaders } from '../setup/audit';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const DAY = 24 * 60;

/**
 * ADR 0050, a guard's going: deactivated, their live swaps are cancelled,
 * their templates ended, their slots to come cancelled and the tasks
 * still theirs cancelled; erased, what they wrote goes — handover notes,
 * task notes, swap reasons. Their export holds their own duty and nobody
 * else's names.
 */
describe('Guard duty and privacy', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Duty Privacy Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const deactivate = (id: string) =>
    x
      .http('patch', `/accounts/${id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);

  it('deactivated: swaps cancelled, templates ended, slots to come cancelled, tasks still theirs cancelled', async () => {
    const leaving = await x.guard(s.c);
    const colleague = await x.guard(s.c);
    const today = localDate(new Date(), 'Africa/Cairo');
    const template = (
      await x
        .templateRaw(supervisor, {
          guardId: leaving.id,
          gateId,
          schedule: { days: [3], windows: [{ from: '06:00', to: '07:00' }] },
          effectiveFrom: addDays(today, 1),
        })
        .expect(201)
    ).body as { id: string };
    const single = await x.slot(
      supervisor,
      leaving.id,
      { gateId },
      2 * DAY + 600,
    );
    const asked = (
      await x
        .http('post', '/gate/swaps', leaving.token, {
          slotId: single.id,
          colleagueId: colleague.id,
        })
        .expect(201)
    ).body as { id: string };
    const theirSlot = await x.slot(
      supervisor,
      colleague.id,
      { gateId },
      3 * DAY + 600,
    );
    const askedOf = (
      await x
        .http('post', '/gate/swaps', colleague.token, {
          slotId: theirSlot.id,
          colleagueId: leaving.id,
        })
        .expect(201)
    ).body as { id: string };
    const task = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'Theirs',
          guardId: leaving.id,
        })
        .expect(201)
    ).body as { id: string };

    await deactivate(leaving.id);

    await x.inTx(s.c, async (tx) => {
      expect(
        await tx.guardRosterTemplate.findUniqueOrThrow({
          where: { id: template.id },
        }),
      ).toMatchObject({ endReason: 'guard_left', endedById: null });
      const coming = await tx.guardRosterSlot.findMany({
        where: { guardAccountId: leaving.id },
      });
      expect(coming.length).toBeGreaterThan(1);
      for (const slot of coming)
        expect(slot).toMatchObject({
          status: 'cancelled',
          cancelReason: 'guard_left',
        });
      for (const id of [asked.id, askedOf.id])
        expect(
          await tx.guardShiftSwap.findUniqueOrThrow({ where: { id } }),
        ).toMatchObject({ status: 'cancelled', closeReason: 'guard_left' });
      expect(
        await tx.guardTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ status: 'cancelled', cancelReason: 'assignee_left' });
      // The colleague's slot stays theirs and scheduled.
      expect(
        await tx.guardRosterSlot.findUniqueOrThrow({
          where: { id: theirSlot.id },
        }),
      ).toMatchObject({ status: 'scheduled', guardAccountId: colleague.id });
    });
  });

  it('on shift when deactivated: the shift ends and the tasks they had go to its post', async () => {
    const leaving = await x.guard(s.c);
    const shift = await x.start(leaving, { gateId });
    const task = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'Carried',
          guardId: leaving.id,
        })
        .expect(201)
    ).body as { id: string };
    await deactivate(leaving.id);
    const row = await x.inTx(s.c, (tx) =>
      tx.guardTask.findUniqueOrThrow({ where: { id: task.id } }),
    );
    expect(row).toMatchObject({
      status: 'open',
      gateId,
      carriedFromShiftId: shift.id,
    });
    expect((await x.shiftRow(s.c, shift.id)).endReason).toBe(
      'account_deactivated',
    );
  });

  it('erased: their handover notes, task notes and swap reasons go, once each, audited', async () => {
    const leaving = await x.guard(s.c);
    const colleague = await x.guard(s.c);
    const shift = await x.start(leaving, { gateId });
    const task = (
      await x
        .http('post', '/staff/security/tasks', supervisor.token, {
          kind: 'custom',
          title: 'Done before',
          gateId,
        })
        .expect(201)
    ).body as { id: string };
    await x
      .http('post', `/gate/tasks/${task.id}/take`, leaving.token)
      .expect(200);
    await x
      .http('post', `/gate/tasks/${task.id}/complete`, leaving.token, {
        outcome: 'done',
        note: 'Told Mr Hany',
      })
      .expect(200);
    const slot = await x.slot(supervisor, leaving.id, { gateId }, 4 * DAY);
    const swap = (
      await x
        .http('post', '/gate/swaps', leaving.token, {
          slotId: slot.id,
          colleagueId: colleague.id,
          reason: 'Visiting my mother',
        })
        .expect(201)
    ).body as { id: string };
    await x.endRaw(leaving, { notes: 'Mr Hany at B7 complained' }).expect(200);
    const handover = await x.inTx(s.c, (tx) =>
      tx.guardHandover.findFirstOrThrow({ where: { shiftId: shift.id } }),
    );

    // Staff are erased once deactivated (active_staff_role).
    await deactivate(leaving.id);
    await eraseNow(h, s.c, leaving.id);

    await x.inTx(s.c, async (tx) => {
      expect(
        await tx.guardHandover.findUniqueOrThrow({
          where: { id: handover.id },
        }),
      ).toMatchObject({
        notes: null,
        notesClearedAt: expect.any(Date) as Date,
      });
      expect(
        await tx.guardTask.findUniqueOrThrow({ where: { id: task.id } }),
      ).toMatchObject({ resultNote: null, outcome: 'done' });
      expect(
        await tx.guardShiftSwap.findUniqueOrThrow({ where: { id: swap.id } }),
      ).toMatchObject({ reason: null, status: 'cancelled' });
    });
    const read = auditReaders(h);
    for (const [action, id] of [
      ['guard_handover.notes_cleared', handover.id],
      ['guard_task.result_cleared', task.id],
      ['guard_swap.reason_cleared', swap.id],
    ] as const)
      expect(
        await read.tenant(s.c.tenantId, { action, targetId: id }),
      ).toHaveLength(1);
  });

  it('a guard’s export holds their own duty, posts by name, no other guard’s name', async () => {
    const guard = await x.guard(s.c);
    const other = await x.guard(s.c);
    const email = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: guard.id } }),
      )
    ).email!;
    const otherName = (
      await x.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({ where: { id: other.id } }),
      )
    ).fullName!;
    await x.start(other, { gateId });
    await x.endRaw(other, { notes: 'Quiet' }).expect(200);
    await x.start(guard, { gateId });
    await x
      .http('post', '/gate/found-items', guard.token, {
        description: 'A red bag',
      })
      .expect(201);
    await x.endRaw(guard, { notes: 'Bag at the gate' }).expect(200);

    await stepUp(h, guard.token, email);
    const asked = await x
      .http('post', '/me/data-exports', guard.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await x
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        guard.token,
      )
      .expect(200);
    const archive = await readArchive((dl.body as { url: string }).url);
    const shifts = JSON.parse(
      archive.text('guard-duty/shifts.json'),
    ) as unknown[];
    expect(shifts).toHaveLength(1);
    const handovers = JSON.parse(archive.text('guard-duty/handovers.json')) as {
      notes: string;
    }[];
    expect(handovers.map((h) => h.notes)).toEqual(['Bag at the gate']);
    const found = JSON.parse(archive.text('guard-duty/found-items.json')) as {
      description: string;
    }[];
    expect(found.map((f) => f.description)).toEqual(['A red bag']);
    expect(archive.all).not.toContain(otherName);
    expect(archive.all).not.toContain('Quiet');
  });
});
