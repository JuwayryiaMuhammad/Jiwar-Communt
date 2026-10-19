import { boardAppealHelpers, type AppealBody } from '../setup/board-appeals';
import type { MotionBody, Who } from '../setup/board-matters';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0055, appeals to the board, on a rejected invoice dispute: who may
 * appeal and see what, within 15 days and once; the board's motion with
 * the unit's people and the appellant recused; an overturn left to the
 * management to follow up; a withdrawal; the overdue notice.
 */
describe('Governance — appeals to the board (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    // o(0), o(1), o(2) sit; o(3)…o(7) own a unit each (its primary).
    s = await a.setUp(8, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const motionOf = (res: { body: unknown }) => res.body as MotionBody;
  const view = async (as: Who, id: string) =>
    (
      await a
        .http('get', `/governance/board-appeals/${id}`, as.token)
        .expect(200)
    ).body as AppealBody;

  describe('who may appeal, and when', () => {
    it('an owner of the unit or its primary; not another owner, a board member or a tenant who is not the primary', async () => {
      const rented = await a.unit(s.c);
      const tenant = await a.tenant(s.c, rented.id);
      const landlord = await a.landlord(s.c, rented.id);
      const d = await a.rejectedDispute(s.manager, tenant, rented.id);
      for (const who of [o(3), o(0)])
        expect(code(await a.lodge(who, d).expect(403))).toBe(
          'BOARD_APPEAL_NOT_ALLOWED',
        );
      // The tenant is the rented unit's primary: they may; so may its landlord.
      const mine = await a.appeal(tenant, d);
      expect(mine).toMatchObject({ kind: 'invoice_dispute', mine: true });
      expect((await view(landlord, mine.id)).grounds).toBeNull();
      // One appeal per decision.
      expect(code(await a.lodge(landlord, d).expect(409))).toBe(
        'BOARD_APPEAL_EXISTS',
      );
    });

    it('only a decision that stands against the unit, within 15 days of it', async () => {
      const unitId = o(4).unitId;
      const { invoiceId } = await a.fin.issue(s.manager, unitId);
      const opened = await a
        .http('post', `/invoices/${invoiceId}/disputes`, o(4).token, {
          reasonCode: 'wrong_amount',
        })
        .expect(201);
      const open = (opened.body as { id: string }).id;
      const notYet = await a.lodge(o(4), open).expect(409);
      expect(notYet.body).toMatchObject({
        code: 'BOARD_APPEAL_NOT_ELIGIBLE',
        params: { reason: 'not_decided' },
      });
      const late = await a.rejectedDispute(s.manager, o(4), unitId);
      await a.decidedDaysAgo(late, 16);
      expect(code(await a.lodge(o(4), late).expect(409))).toBe(
        'BOARD_APPEAL_WINDOW_PASSED',
      );
      expect(
        code(
          await a
            .lodge(o(4), '0193b8a4-0000-7000-8000-00000000abcd')
            .expect(404),
        ),
      ).toBe('BOARD_APPEAL_SUBJECT_NOT_FOUND');
    });
  });

  describe('lodged and decided', () => {
    let appeal: AppealBody;

    it('lodged: the board told; the appellant reads the grounds, the staff and other owners never', async () => {
      const d = await a.rejectedDispute(s.manager, o(5), o(5).unitId);
      appeal = await a.appeal(o(5), d, { grounds: 'APPEAL-GROUNDS words' });
      expect(appeal).toMatchObject({
        reference: expect.stringMatching(/^BA-\d{4}$/) as string,
        status: 'pending',
        grounds: 'APPEAL-GROUNDS words',
        subject: {
          status: 'rejected',
          decisionReasonCode: 'charge_is_correct',
        },
      });
      for (const member of [o(0), o(1), o(2)])
        expect(
          (
            await a.notifications(s.c, member.id, 'governance_appeal.lodged')
          ).filter((n) => n.targetId === appeal.id),
        ).toHaveLength(1);
      const staff = await a
        .http(
          'get',
          `/staff/governance/board-appeals/${appeal.id}`,
          s.manager.token,
        )
        .expect(200);
      expect(JSON.stringify(staff.body)).not.toContain('APPEAL-GROUNDS');
      const board = await a
        .http('get', `/board/appeals/${appeal.id}`, o(0).token)
        .expect(200);
      expect(board.body).toMatchObject({
        grounds: 'APPEAL-GROUNDS words',
        motions: [],
      });
      // The dispute says it was taken to the board.
      const dispute = await a
        .http('get', `/invoice-disputes/${d}`, o(5).token)
        .expect(200);
      expect(dispute.body).toMatchObject({
        boardAppealAt: expect.any(String) as string,
        boardAppealUntil: null,
      });
    });

    it('overturned: the reasoned decision to the appellant and the manager; the management follows it up, once', async () => {
      const m = motionOf(await a.proposeOn(o(0), appeal.id).expect(201));
      await a.vote(o(0), m.id, 'for').expect(201);
      expect(motionOf(await a.vote(o(1), m.id, 'for').expect(201)).status).toBe(
        'carried',
      );
      expect(await view(o(5), appeal.id)).toMatchObject({
        status: 'overturned',
        decision: {
          outcome: 'overturned',
          rationale: 'The receipt shows the payment.',
        },
      });
      for (const who of [o(5), s.manager]) {
        const told = (
          await a.notifications(s.c, who.id, 'governance_appeal.decided')
        ).filter((n) => n.targetId === appeal.id);
        expect(told).toHaveLength(1);
        expect(told[0].params).toEqual({
          kind: 'invoice_dispute',
          outcome: 'overturned',
        });
      }
      const staff = (
        await a
          .http(
            'get',
            `/staff/governance/board-appeals/${appeal.id}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { effect: string; followedUpAt: string | null };
      expect(staff).toMatchObject({ effect: 'follow_up', followedUpAt: null });
      await a
        .http(
          'post',
          `/staff/governance/board-appeals/${appeal.id}/followed-up`,
          s.manager.token,
          {},
        )
        .expect(200);
      expect(
        code(
          await a
            .http(
              'post',
              `/staff/governance/board-appeals/${appeal.id}/followed-up`,
              s.manager.token,
              {},
            )
            .expect(409),
        ),
      ).toBe('BOARD_APPEAL_NO_FOLLOW_UP');
    });

    it('withdrawn by the appellant only: its open motion closes', async () => {
      const d = await a.rejectedDispute(s.manager, o(6), o(6).unitId);
      const x = await a.appeal(o(6), d);
      const m = motionOf(await a.proposeOn(o(0), x.id).expect(201));
      const coOwner = await a.owner(s.c, o(6).unitId);
      expect(
        code(
          await a
            .http(
              'post',
              `/governance/board-appeals/${x.id}/withdraw`,
              coOwner.token,
              {},
            )
            .expect(403),
        ),
      ).toBe('BOARD_APPEAL_NOT_YOURS');
      await a
        .http(
          'post',
          `/governance/board-appeals/${x.id}/withdraw`,
          o(6).token,
          {},
        )
        .expect(200);
      expect(code(await a.vote(o(1), m.id, 'for').expect(409))).toBe(
        'BOARD_MOTION_CLOSED',
      );
    });
  });

  describe('recusal', () => {
    it('a member who owns the unit, or appealed, takes no part; the others count without them', async () => {
      // o(2) also owns o(7)'s unit.
      await a.coOwn(s.c, s.manager, o(2), o(7).unitId);
      const d = await a.rejectedDispute(s.manager, o(7), o(7).unitId);
      const x = await a.appeal(o(7), d);
      expect(code(await a.proposeOn(o(2), x.id).expect(403))).toBe(
        'BOARD_MEMBER_RECUSED',
      );
      const m = motionOf(
        await a
          .proposeOn(o(0), x.id, {
            outcome: 'uphold',
            rationale: 'The charge stands.',
          })
          .expect(201),
      );
      // Recused: the unit's owners (o(7), o(2)), and the appellant.
      expect(m).toMatchObject({ recused: 2, tally: { seats: 2, quorum: 2 } });
      expect(code(await a.vote(o(2), m.id, 'for').expect(403))).toBe(
        'BOARD_MEMBER_RECUSED',
      );
      expect(code(await a.close(o(2), m.id).expect(403))).toBe(
        'BOARD_MEMBER_RECUSED',
      );
      await a.vote(o(0), m.id, 'for').expect(201);
      expect(
        motionOf(await a.vote(o(1), m.id, 'for').expect(201)),
      ).toMatchObject({
        status: 'carried',
        tally: { seats: 2, for: 2, against: 0 },
      });
      expect((await view(o(7), x.id)).status).toBe('upheld');
    });

    it('too few may act for the board’s quorum: it waits, and past its deadline the management hears', async () => {
      // o(0) and o(1) both own o(3)'s unit too: one member left of three.
      for (const member of [o(0), o(1)])
        await a.coOwn(s.c, s.manager, member, o(3).unitId);
      const d = await a.rejectedDispute(s.manager, o(3), o(3).unitId);
      const x = await a.appeal(o(3), d);
      const res = await a.proposeOn(o(2), x.id).expect(409);
      expect(res.body).toMatchObject({
        code: 'BOARD_QUORUM_UNAVAILABLE',
        params: { eligible: 1, quorum: 2 },
      });
      await a.appealOverdue(x.id);
      await a.sweepMatters();
      await a.sweepMatters();
      for (const who of [s.manager, o(2)])
        expect(
          (
            await a.notifications(s.c, who.id, 'governance_appeal.overdue')
          ).filter((n) => n.targetId === x.id),
        ).toHaveLength(1);
    });

    it('a member who joins the unit after a motion opened is not recused from it', async () => {
      const unit = await a.unit(s.c);
      const owner = await a.owner(s.c, unit.id);
      const d = await a.rejectedDispute(s.manager, owner, unit.id);
      const x = await a.appeal(owner, d);
      const m = motionOf(await a.proposeOn(o(0), x.id).expect(201));
      await a.coOwn(s.c, s.manager, o(1), unit.id);
      expect(
        motionOf(await a.vote(o(1), m.id, 'for').expect(201)).tally.seats,
      ).toBe(3);
    });
  });
  describe('privacy', () => {
    it('an appellant’s erasure clears the grounds and attachments, once; the appeal stays and is still decided', async () => {
      const coOwner = await a.owner(s.c, o(4).unitId);
      const d = await a.rejectedDispute(s.manager, o(4), o(4).unitId);
      const photo = await a.files.ready(
        coOwner.token,
        'board_appeal_attachment',
      );
      const x = await a.appeal(coOwner, d, {
        grounds: 'PII-APPEAL-GROUNDS',
        attachmentIds: [photo],
      });
      await eraseNow(h, s.c, coOwner.id);
      const board = await a
        .http('get', `/board/appeals/${x.id}`, o(0).token)
        .expect(200);
      expect(JSON.stringify(board.body)).not.toContain('PII-APPEAL-GROUNDS');
      expect(board.body).toMatchObject({
        grounds: null,
        status: 'pending',
        attachments: [{ fileId: photo, url: null }],
      });
      const m = motionOf(
        await a
          .proposeOn(o(0), x.id, { outcome: 'uphold', rationale: 'Stands.' })
          .expect(201),
      );
      await a.vote(o(0), m.id, 'for').expect(201);
      await a.vote(o(1), m.id, 'for').expect(201);
      const staff = await a
        .http('get', `/staff/governance/board-appeals/${x.id}`, s.manager.token)
        .expect(200);
      expect(staff.body).toMatchObject({ status: 'upheld', effect: 'none' });
    });

    it('the export holds the account’s own appeals with its grounds and the decision', async () => {
      const d = await a.rejectedDispute(s.manager, o(6), o(6).unitId);
      const x = await a.appeal(o(6), d, { grounds: 'EXPORT-GROUNDS' });
      const email = (
        await a.x.asManager(s.c, () =>
          a.x.prisma.tenant.account.findUniqueOrThrow({
            where: { id: o(6).id },
          }),
        )
      ).email!;
      await stepUp(h, o(6).token, email);
      const asked = await a
        .http('post', '/me/data-exports', o(6).token, {})
        .expect(201);
      await buildExports(h);
      const dl = await a
        .http(
          'get',
          `/me/data-exports/${(asked.body as { id: string }).id}/download`,
          o(6).token,
        )
        .expect(200);
      const archive = await readArchive((dl.body as { url: string }).url);
      const mine = JSON.parse(
        archive.text('governance/board-appeals.json'),
      ) as { reference: string; grounds: string | null }[];
      expect(mine).toContainEqual(
        expect.objectContaining({
          reference: x.reference,
          grounds: 'EXPORT-GROUNDS',
        }),
      );
    });
  });
});
