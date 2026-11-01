import { auditReaders } from '../setup/audit';
import { boardMatterHelpers, type Who } from '../setup/board-matters';
import { day } from '../setup/compound-clock';
import { financeHelpers } from '../setup/finance';
import { lapse } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;

interface PackBody {
  id: string;
  termId: string;
  previousTermId: string | null;
  contents: {
    approvals: {
      pending: { reference: string; type: string }[];
      awaitingImplementation: { reference: string }[];
    };
    appeals: { pending: unknown[] };
    openActions: { meetingReference: string; title: string; dueOn: string }[];
    agendaProposalsOpen: number;
    objectionsUnanswered: number;
    latestMinutes: unknown;
    previousTerm: { id: string } | null;
    sections: {
      contracts?: { withinDays: number; ending: unknown[] };
      budget?: { active: unknown[] };
    };
  };
}

interface HandoverBody {
  id: string;
  accountId: string;
  status: string;
  notes: string | null;
  contents: Record<string, unknown> | null;
  deliveredAt: string | null;
}

/**
 * ADR 0075: handovers — the pack a new board receives when it starts to
 * sit (what the board before left open, by reference; never a name), and
 * a manager's handover, drafted and delivered once; while a board sits a
 * manager's account is not deactivated (HANDOVER_PENDING) until they
 * delivered one or the board approved going without.
 */
describe('Governance — handovers', () => {
  let h: HttpHarness;
  let b: ReturnType<typeof boardMatterHelpers>;
  let f: ReturnType<typeof financeHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardMatterHelpers>['setUp']>>;
  let admin: Who;
  const o = (i: number) => s.owners[i];

  beforeAll(async () => {
    h = await createHttpHarness();
    b = boardMatterHelpers(h);
    f = financeHelpers(h);
    s = await b.setUp(6, 3);
    admin = await f.platformAdmin();
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const pack = async (as: Who): Promise<PackBody> =>
    (await b.http('get', '/board/handover-pack', as.token).expect(200))
      .body as PackBody;
  /** A manager the platform adds to the compound. */
  const newManager = async (label: string): Promise<Who> => {
    const p = b.x.person(label);
    const added = (
      await b
        .http(
          'post',
          `/platform/tenants/${s.c.tenantId}/managers`,
          admin.token,
          p,
        )
        .expect(201)
    ).body as { id: string };
    return b.who(s.c, added.id, 'manager');
  };
  const managerStatus = (status: 'active' | 'inactive', accountId: string) =>
    b.http(
      'patch',
      `/platform/tenants/${s.c.tenantId}/managers/${accountId}/status`,
      admin.token,
      { status },
    );

  describe('the board’s pack', () => {
    it('the first board’s pack: nothing before it', async () => {
      const first = await pack(o(0));
      expect(first).toMatchObject({
        termId: s.term.id,
        previousTermId: null,
        contents: { previousTerm: null, openActions: [] },
      });
      expect(first.contents.sections.contracts).toMatchObject({
        withinDays: 90,
      });
      expect(first.contents.sections.budget).toMatchObject({ active: [] });
    });

    it('a new board’s pack lists what the board before left open, by reference; never a name', async () => {
      const request = await b.raise(s.accountant);
      const meeting = (
        await b
          .http('post', '/board/meetings', o(0).token, {
            kind: 'regular',
            title: 'The last meeting',
            scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString(),
          })
          .expect(201)
      ).body as { id: string; reference: string };
      await b
        .http('post', `/board/meetings/${meeting.id}/hold`, o(0).token, {
          presentMemberIds: [],
        })
        .expect(200);
      await b
        .http('post', `/board/meetings/${meeting.id}/actions`, o(0).token, {
          title: 'Renew the lift contract',
          ownerAccountId: o(1).id,
          dueOn: day(20),
        })
        .expect(201);
      await lapse(s.term.id);
      const next = await b.appoint(s.manager, [o(3), o(4), o(5)]);
      const p = await pack(o(3));
      expect(p.termId).toBe(next.id);
      expect(p.previousTermId).toBe(s.term.id);
      expect(p.contents.previousTerm).toMatchObject({ id: s.term.id });
      expect(p.contents.approvals.pending).toContainEqual(
        expect.objectContaining({ type: 'exceptional_fee' }),
      );
      expect(p.contents.openActions).toEqual([
        {
          meetingReference: meeting.reference,
          title: 'Renew the lift contract',
          dueOn: day(20),
        },
      ]);
      const text = JSON.stringify(p);
      for (const who of [o(0), o(1), s.manager])
        expect(text).not.toContain(who.id);
      expect(request.id).toBeDefined();
      const audited = await auditReaders(h).tenant(s.c.tenantId, {
        action: 'board_handover_pack.generated',
        targetId: p.id,
      });
      expect(audited[0]).toMatchObject({
        metadata: { termId: next.id, previousTermId: s.term.id },
      });
      s.term = next;
    });

    it('its PDF; the old board and owners off it read nothing', async () => {
      const res = await b
        .http('get', '/board/handover-pack/pdf', o(3).token)
        .expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect((res.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      await b.http('get', '/board/handover-pack', o(0).token).expect(403);
      await b.http('get', '/board/handover-pack', s.manager.token).expect(200);
    });
  });

  describe('the manager’s handover', () => {
    let second: Who;

    beforeAll(async () => {
      // A second manager, the one who leaves.
      second = await newManager('mgr2');
    });

    it('while a board sits, a manager who delivered nothing is not deactivated', async () => {
      expect(code(await managerStatus('inactive', second.id).expect(409))).toBe(
        'HANDOVER_PENDING',
      );
    });

    it('drafted, then delivered once with its snapshot; the board and the other managers told', async () => {
      await b
        .http('post', '/staff/governance/handover/deliver', second.token)
        .expect(404);
      const draft = (
        await b
          .http('put', '/staff/governance/handover', second.token, {
            notes: 'The pool pump needs a new seal in March.',
          })
          .expect(200)
      ).body as HandoverBody;
      expect(draft).toMatchObject({ status: 'draft', contents: null });
      const done = (
        await b
          .http('post', '/staff/governance/handover/deliver', second.token)
          .expect(200)
      ).body as HandoverBody;
      expect(done).toMatchObject({ id: draft.id, status: 'delivered' });
      expect(done.contents).toMatchObject({
        approvals: { pending: expect.any(Array) as unknown[] },
      });
      for (const who of [o(3), s.manager])
        expect(
          (
            await b.notifications(s.c, who.id, 'manager_handover.delivered')
          ).map((n) => n.targetId),
        ).toEqual([draft.id]);
      // Kept as delivered: a new write starts a new draft.
      const again = (
        await b
          .http('put', '/staff/governance/handover', second.token, {
            notes: null,
          })
          .expect(200)
      ).body as HandoverBody;
      expect(again.id).not.toBe(draft.id);
      const list = (
        await b.http('get', '/board/manager-handovers', o(3).token).expect(200)
      ).body as { data: HandoverBody[] };
      expect(list.data.map((x) => x.id)).toEqual([draft.id]);
      // A draft is its writer's alone.
      await b
        .http('get', `/board/manager-handovers/${again.id}`, o(3).token)
        .expect(404);
      const pdf = await b
        .http('get', `/board/manager-handovers/${draft.id}/pdf`, o(3).token)
        .expect(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
    });

    it('delivered, the manager may be deactivated', async () => {
      await managerStatus('inactive', second.id).expect(200);
    });

    it('the board approves a manager leaving without one: then they may be deactivated', async () => {
      const third = await newManager('mgr3');
      expect(code(await managerStatus('inactive', third.id).expect(409))).toBe(
        'HANDOVER_PENDING',
      );
      const request = await b.raise(s.accountant, {
        type: 'manager_handover_override',
        managerAccountId: third.id,
        cost: undefined,
      });
      // Not a manager: refused at the raise.
      const wrong = await b
        .http('post', '/staff/governance/approvals', s.accountant.token, {
          type: 'manager_handover_override',
          managerAccountId: o(0).id,
          context: 'c',
          impact: 'i',
        })
        .expect(409);
      expect(wrong.body).toMatchObject({
        code: 'MANAGER_HANDOVER_NOT_PENDING',
        params: { reason: 'not_a_manager' },
      });
      const m = await b.motion(o(3), request.id);
      await b.vote(o(3), m.id, 'for').expect(201);
      await b.vote(o(4), m.id, 'for').expect(201);
      await managerStatus('inactive', third.id).expect(200);
    });

    it('with no board sitting, nothing blocks', async () => {
      const fourth = await newManager('mgr4');
      await lapse(s.term.id);
      await managerStatus('inactive', fourth.id).expect(200);
    });
  });
});
