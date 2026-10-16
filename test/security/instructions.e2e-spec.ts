import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;

interface InstructionBody {
  id: string;
  title: string;
  urgent: boolean;
  audience: string;
  acknowledgedAt?: string | null;
  recipients?: number;
  acknowledged?: number;
  reached?: {
    guard: { id: string };
    addedVia: string;
    acknowledgedAt: string | null;
  }[];
}

/**
 * ADR 0050: the management sends guards instructions — to all of them, a
 * gate or a zone — and every guard it reaches acknowledges each one. It
 * reaches the guards there at the send (on shift, or scheduled in the next
 * seven days) and anyone who opens a shift there while it is live. Urgent
 * is a critical push. Archived, it reaches nobody new.
 */
describe('Instructions to guards', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Instructions Court');
    supervisor = await x.supervisor(s.c);
  }, 120_000);

  afterAll(() => h.close());

  const send = (body: Record<string, unknown>) =>
    x.http('post', '/staff/security/instructions', supervisor.token, body);
  const sent = async (body: Record<string, unknown>) =>
    (await send(body).expect(201)).body as InstructionBody;
  const pending = async (as: Who) =>
    (
      (
        await x
          .http('get', '/gate/guard-instructions?status=pending', as.token)
          .expect(200)
      ).body as { data: InstructionBody[] }
    ).data.map((i) => i.id);
  const told = async (accountId: string, id: string) =>
    (await x.notifications(s.c, accountId))
      .filter((n) => n.targetId === id)
      .map((n) => n.kind);

  it('to a gate: its guards on shift and scheduled, told; a guard opening a shift there later is reached too; each acknowledges once', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const onShift = await x.guard(s.c);
    const scheduled = await x.guard(s.c);
    const elsewhere = await x.guard(s.c);
    const later = await x.guard(s.c);
    await x.start(onShift, { gateId });
    await x.slot(supervisor, scheduled.id, { gateId }, 2 * 24 * 60);
    await x.start(elsewhere, { gateId: (await x.g.gate(s.c)).id });
    const i = await sent({
      title: 'Visitors after 22:00',
      body: 'Call the host before letting anyone in.',
      audience: 'gate',
      gateId,
    });
    expect(i).toMatchObject({ urgent: false, recipients: 2, acknowledged: 0 });
    for (const g of [onShift, scheduled])
      expect(await told(g.id, i.id)).toEqual(['guard_instruction.issued']);
    expect(await told(elsewhere.id, i.id)).toEqual([]);
    expect(await pending(elsewhere)).not.toContain(i.id);
    expect(
      code(
        await x.http(
          'get',
          `/gate/guard-instructions/${i.id}`,
          elsewhere.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'GUARD_INSTRUCTION_NOT_FOUND' });

    await x.start(later, { gateId });
    expect(await pending(later)).toContain(i.id);
    expect(await told(later.id, i.id)).toEqual([]);

    const acked = await x
      .http(
        'post',
        `/gate/guard-instructions/${i.id}/acknowledge`,
        onShift.token,
      )
      .expect(200);
    const again = await x
      .http(
        'post',
        `/gate/guard-instructions/${i.id}/acknowledge`,
        onShift.token,
      )
      .expect(200);
    expect(again.body).toEqual(acked.body);
    expect(await pending(onShift)).not.toContain(i.id);

    const detail = (
      await x
        .http('get', `/staff/security/instructions/${i.id}`, supervisor.token)
        .expect(200)
    ).body as InstructionBody;
    expect(detail).toMatchObject({ recipients: 3, acknowledged: 1 });
    expect(
      detail.reached!.map((r) => [
        r.guard.id,
        r.addedVia,
        r.acknowledgedAt !== null,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [onShift.id, 'send', true],
        [scheduled.id, 'send', false],
        [later.id, 'shift_start', false],
      ]),
    );
    for (const g of [onShift, elsewhere, later]) await x.endRaw(g).expect(200);
  });

  it('urgent to all: every guard, a critical push; my work counts what waits for me', async () => {
    const guard = await x.guard(s.c);
    const i = await sent({
      title: 'Lockdown drill',
      body: 'Close every gate at 15:00.',
      audience: 'all',
      urgent: true,
    });
    expect(await told(guard.id, i.id)).toEqual(['guard_instruction.urgent']);
    const work = (await x.http('get', '/gate/my-work', guard.token).expect(200))
      .body as { pendingInstructions: number };
    expect(work.pendingInstructions).toBeGreaterThanOrEqual(1);
  });

  it('archived: it reaches nobody new, once; the archive is searchable', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const before = await x.guard(s.c);
    await x.start(before, { gateId });
    const i = await sent({
      title: 'Ramadan hours',
      body: 'The north gate opens at 09:00.',
      audience: 'gate',
      gateId,
    });
    await x
      .http(
        'post',
        `/staff/security/instructions/${i.id}/archive`,
        supervisor.token,
      )
      .expect(200);
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/instructions/${i.id}/archive`,
          supervisor.token,
        ),
      ),
    ).toEqual({ status: 409, code: 'GUARD_INSTRUCTION_ARCHIVED' });
    const after = await x.guard(s.c);
    await x.start(after, { gateId });
    expect(await pending(after)).not.toContain(i.id);
    const found = (
      await x
        .http('get', '/gate/guard-instructions?q=ramadan', before.token)
        .expect(200)
    ).body as { data: InstructionBody[] };
    expect(found.data.map((d) => d.id)).toEqual([i.id]);
    for (const g of [before, after]) await x.endRaw(g).expect(200);
  });

  it('an audience names its post: a gate for gate, a zone for zone, none for all', async () => {
    const gateId = (await x.g.gate(s.c)).id;
    const base = { title: 'T', body: 'B' };
    expect(fields(await send({ ...base, audience: 'gate' }))).toEqual([
      { field: 'gateId', code: 'FIELD_REQUIRED' },
    ]);
    expect(fields(await send({ ...base, audience: 'zone', gateId }))).toEqual([
      { field: 'gateId', code: 'FIELD_NOT_ALLOWED' },
      { field: 'zoneId', code: 'FIELD_REQUIRED' },
    ]);
    expect(fields(await send({ ...base, audience: 'all', gateId }))).toEqual([
      { field: 'gateId', code: 'FIELD_NOT_ALLOWED' },
    ]);
  });
});
