import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { HELP_ESCALATION_SWEEP } from '../../src/maintenance/help/help-requests.service';
import { auditReaders } from '../setup/audit';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { fieldTeamHelpers } from '../setup/field-team';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import type { Who } from '../setup/safety';

const MINUTE = 60_000;
const NOTE = 'Stuck on the roof, the hatch is jammed';

interface Help {
  id: string;
  kind: string;
  status: string;
  note: string | null;
  helper: { id: string } | null;
  takenBy: { id: string } | null;
  escalatedAt: string | null;
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

/**
 * ADR 0078: a technician calls for help; the field team is told at once,
 * takes it (sending another technician or none) and it is resolved or
 * called off. One live call per technician; nobody taking it in fifteen
 * minutes escalates it to the managers, once. The note is the caller's
 * own words, never in a notification.
 */
describe('A technician’s call for help', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof fieldTeamHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof fieldTeamHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = fieldTeamHelpers(h);
    s = await x.setUp('Field Help Court');
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  const call = (as: Who, body: object = {}) =>
    x.http('post', '/maintenance/help-requests', as.token, {
      kind: 'safety',
      note: NOTE,
      ...body,
    });
  const take = (id: string, body: object = {}) =>
    x.http(
      'post',
      `/staff/field-team/help-requests/${id}/take`,
      s.boss.token,
      body,
    );

  it('the field team is told at once, by the kind alone; one live call at a time; a ticket must be theirs', async () => {
    const tech = await x.technician(s.c);
    const help = (await call(tech).expect(201)).body as Help;
    expect(help).toMatchObject({ kind: 'safety', status: 'open', note: NOTE });
    const told = await x.told(s.c, s.boss.id, help.id);
    expect(told).toEqual([
      { kind: 'technician_help.requested', params: { helpKind: 'safety' } },
    ]);
    expect(JSON.stringify(told)).not.toContain('roof');
    expect(await x.told(s.c, s.c.managerId, help.id)).toEqual([
      { kind: 'technician_help.requested', params: { helpKind: 'safety' } },
    ]);
    expect(code(await call(tech, { kind: 'parts' }))).toEqual({
      status: 409,
      code: 'TECHNICIAN_HELP_LIVE',
    });
    // A ticket that is not theirs (here: none at all) is not found.
    const other = await x.technician(s.c);
    expect(code(await call(other, { ticketId: newId() }))).toEqual({
      status: 404,
      code: 'TICKET_NOT_FOUND',
    });
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'technician_help.requested',
          targetId: help.id,
        })
      )[0],
    ).toMatchObject({ actorId: tech.id, metadata: { kind: 'safety' } });
  });

  it('taken once, sending a technician; the caller and the helper told; resolved by the helper', async () => {
    const tech = await x.technician(s.c);
    const helper = await x.technician(s.c);
    const guard = await x.guard(s.c);
    const help = (await call(tech).expect(201)).body as Help;
    expect(fields(await take(help.id, { helperId: guard.id }))).toEqual([
      { field: 'helperId', code: 'GUARD_NOT_ELIGIBLE' },
    ]);
    expect(fields(await take(help.id, { helperId: tech.id }))).toEqual([
      { field: 'helperId', code: 'GUARD_NOT_ELIGIBLE' },
    ]);
    const taken = (await take(help.id, { helperId: helper.id }).expect(200))
      .body as Help;
    expect(taken).toMatchObject({
      status: 'taken',
      helper: { id: helper.id },
      takenBy: { id: s.boss.id },
    });
    expect(code(await take(help.id))).toEqual({
      status: 409,
      code: 'TECHNICIAN_HELP_CLOSED',
    });
    expect(await x.told(s.c, tech.id, help.id)).toEqual([
      { kind: 'technician_help.taken', params: {} },
    ]);
    expect(await x.told(s.c, helper.id, help.id)).toEqual([
      { kind: 'technician_help.assigned', params: { helpKind: 'safety' } },
    ]);
    const mine = await x
      .http('get', '/maintenance/help-requests/mine', helper.token)
      .expect(200);
    expect((mine.body as { data: Help[] }).data.map((r) => r.id)).toContain(
      help.id,
    );
    // A stranger may not resolve it.
    const stranger = await x.technician(s.c);
    expect(
      code(
        await x.http(
          'post',
          `/maintenance/help-requests/${help.id}/resolve`,
          stranger.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'TECHNICIAN_HELP_NOT_FOUND' });
    const resolved = await x
      .http(
        'post',
        `/maintenance/help-requests/${help.id}/resolve`,
        helper.token,
      )
      .expect(200);
    expect(resolved.body).toMatchObject({ status: 'resolved' });
    // Free to call again.
    await call(tech, { kind: 'parts' }).expect(201);
  });

  it('called off by the caller only, while open or taken', async () => {
    const tech = await x.technician(s.c);
    const help = (await call(tech).expect(201)).body as Help;
    const other = await x.technician(s.c);
    expect(
      code(
        await x.http(
          'post',
          `/maintenance/help-requests/${help.id}/cancel`,
          other.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'TECHNICIAN_HELP_NOT_FOUND' });
    await x
      .http('post', `/maintenance/help-requests/${help.id}/cancel`, tech.token)
      .expect(200);
    expect(
      code(
        await x.http(
          'post',
          `/maintenance/help-requests/${help.id}/cancel`,
          tech.token,
        ),
      ),
    ).toEqual({ status: 409, code: 'TECHNICIAN_HELP_CLOSED' });
    expect(code(await take(help.id))).toEqual({
      status: 409,
      code: 'TECHNICIAN_HELP_CLOSED',
    });
  });

  it('nobody took it in fifteen minutes: escalated to the managers, once; a taken one never', async () => {
    const tech = await x.technician(s.c);
    const help = (await call(tech, { kind: 'expertise' }).expect(201))
      .body as Help;
    const busy = await x.technician(s.c);
    const handled = (await call(busy).expect(201)).body as Help;
    await take(handled.id).expect(200);
    await x.sweep(HELP_ESCALATION_SWEEP, new Date(Date.now() + 10 * MINUTE));
    expect(await x.told(s.c, s.c.managerId, help.id)).toEqual([
      { kind: 'technician_help.requested', params: { helpKind: 'expertise' } },
    ]);
    const later = new Date(Date.now() + 16 * MINUTE);
    await x.sweep(HELP_ESCALATION_SWEEP, later);
    await x.sweep(HELP_ESCALATION_SWEEP, later);
    expect(await x.told(s.c, s.c.managerId, help.id)).toEqual([
      { kind: 'technician_help.requested', params: { helpKind: 'expertise' } },
      { kind: 'technician_help.escalated', params: { helpKind: 'expertise' } },
    ]);
    const row = await x
      .http('get', `/staff/field-team/help-requests/${help.id}`, s.boss.token)
      .expect(200);
    expect((row.body as Help).escalatedAt).not.toBeNull();
    expect(
      (await x.told(s.c, s.c.managerId, handled.id)).map((t) => t.kind),
    ).not.toContain('technician_help.escalated');
    // Escalated, it can still be taken.
    await take(help.id).expect(200);
  });

  it('a technician who leaves calls off their live call', async () => {
    const tech = await x.technician(s.c);
    const help = (await call(tech).expect(201)).body as Help;
    await x.v.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(tech.id, { status: 'inactive' }),
    );
    const row = await x
      .http('get', `/staff/field-team/help-requests/${help.id}`, s.boss.token)
      .expect(200);
    expect(row.body).toMatchObject({ status: 'cancelled' });
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'technician_help.cancelled',
          targetId: help.id,
        })
      )[0],
    ).toMatchObject({ metadata: { was: 'open', by: 'system' } });
  });

  it('the caller’s export holds their calls and their slots; never another’s note', async () => {
    const tech = await x.technician(s.c);
    const helper = await x.technician(s.c);
    const help = (await call(tech).expect(201)).body as Help;
    await take(help.id, { helperId: helper.id }).expect(200);
    await x.dutySlot(s.c, tech.id, 30, 60);
    await x.onDuty(tech);
    await x.offDuty(tech);
    const exportOf = async (who: Who) => {
      const { email } = await x.v.inTx(s.c, (tx) =>
        tx.account.findUniqueOrThrow({
          where: { id: who.id },
          select: { email: true },
        }),
      );
      await stepUp(h, who.token, email!);
      const asked = await x
        .http('post', '/me/data-exports', who.token, {})
        .expect(201);
      await buildExports(h);
      const dl = await x
        .http(
          'get',
          `/me/data-exports/${(asked.body as { id: string }).id}/download`,
          who.token,
        )
        .expect(200);
      return readArchive((dl.body as { url: string }).url);
    };
    const mine = await exportOf(tech);
    expect(JSON.parse(mine.text('field-team/help-requests.json'))).toEqual([
      expect.objectContaining({
        role: 'caller',
        kind: 'safety',
        note: NOTE,
        helped: true,
      }),
    ]);
    expect(JSON.parse(mine.text('field-team/slots.json'))).toEqual([
      expect.objectContaining({ zone: null, overtimeMinutes: 0 }),
    ]);
    const theirs = await exportOf(helper);
    expect(JSON.parse(theirs.text('field-team/help-requests.json'))).toEqual([
      expect.objectContaining({ role: 'helper', kind: 'safety' }),
    ]);
    expect(theirs.all).not.toContain('roof');
  });
});
