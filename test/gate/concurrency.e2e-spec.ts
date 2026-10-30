import type { GateSubjectType } from '@prisma/client';
import { Client } from 'pg';
import type { Response } from 'supertest';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { EntriesService } from '../../src/gate/entries/entries.service';
import { gateHelpers } from '../setup/gate';
import { required } from '../setup/test-env';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call, err } from '../api/request';
import { passBody } from '../api/routes/visitors';
import { buildWorld, type World } from '../api/world';
import { whileShiftEnds } from '../setup/shift-end';

/**
 * The gate's races (ADR 0028), each run for real with Promise.all: every
 * outcome is one of the allowed ones, and the database agrees.
 *
 * A guard's write while their shift ends (ADR 0056's lock order): it takes
 * the account, then the shift, FOR SHARE, so it waits for the end and is
 * refused, never written by a guard off duty.
 */
describe('Gate concurrency', () => {
  let h: HttpHarness;
  let w: World;
  let homeCode: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    homeCode = (
      await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.unit.findUniqueOrThrow({
          where: { id: w.a.homeUnitId },
        }),
      )
    ).code;
  }, 120_000);

  afterAll(() => h.close());

  const ROUNDS = 5;
  const guard = () => w.a.tokens.guard;
  const ask = async () =>
    (
      (
        await call(w, 'POST', '/gate/approval-requests', {
          token: guard(),
          body: { kind: 'uninvited_visitor', unitCode: homeCode },
        }).expect(201)
      ).body as { id: string }
    ).id;
  const decide = (id: string, token: string, decision: string) =>
    call(w, 'POST', `/gate-requests/${id}/decide`, {
      token,
      body: { decision },
    });
  const enter = (subjectType: string, subjectId: string, token = guard()) =>
    call(w, 'POST', '/gate/entries', {
      token,
      body: { subjectType, subjectId, direction: 'in' },
    });
  const entries = (subjectId: string) =>
    w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.gateEntry.count({ where: { subjectId } }),
    );

  it('approve and deny at once: deny always wins before the entry', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await ask();
      await Promise.all([
        decide(id, w.a.tokens.owner, 'approve'),
        decide(id, w.a.tokens.family, 'deny'),
      ]);
      const row = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.gateApprovalRequest.findUniqueOrThrow({
          where: { id },
        }),
      );
      expect(row.status).toBe('denied');
    }
  });

  it('a deny racing the entry: exactly one of them takes effect', async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const id = await ask();
      await decide(id, w.a.tokens.owner, 'approve').expect(200);
      const [entry, deny] = await Promise.all([
        enter('gate_request', id),
        decide(id, w.a.tokens.family, 'deny'),
      ]);
      const entered = entry.status === 201;
      const denied = deny.status === 200;
      expect(entered !== denied).toBe(true);
      if (entered)
        expect(err(deny)).toMatchObject({ code: 'GATE_REQUEST_DECIDED' });
      else
        expect(err(entry)).toMatchObject({
          code: 'GATE_ENTRY_REFUSED',
          params: { reason: 'not_approved' },
        });
      expect(await entries(id)).toBe(entered ? 1 : 0);
    }
  });

  it('two guards let the same one-time pass in: once', async () => {
    const second = await gateHelpers(h).guard(w.a);
    await gateHelpers(h).startShift(w.a, second.id, w.a.gateId);
    const secondToken = await w.tokenFor(w.a, second.id, 'staff');
    for (let i = 0; i < ROUNDS; i++) {
      const pass = (
        await call(w, 'POST', `/units/${w.a.homeUnitId}/visitor-passes`, {
          token: w.a.tokens.owner,
          body: passBody(),
        }).expect(201)
      ).body as { id: string };
      const results = await Promise.all([
        enter('visitor_pass', pass.id),
        enter('visitor_pass', pass.id, secondToken),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await entries(pass.id)).toBe(1);
    }
  });

  it('a group pass at two gates at once: never more entries than people', async () => {
    // A second guard on duty at another gate (ADR 0043).
    const other = await gateHelpers(h).onDuty(w.a);
    const otherToken = await w.tokenFor(w.a, other.guardId, 'staff');
    for (let i = 0; i < ROUNDS; i++) {
      const pass = (
        await call(w, 'POST', `/units/${w.a.homeUnitId}/visitor-passes`, {
          token: w.a.tokens.owner,
          body: passBody({ partySize: 3 }),
        }).expect(201)
      ).body as { id: string };
      // Five of the group at once, at both gates: three come in.
      const results = await Promise.all(
        [0, 1, 2, 3, 4].map((n) =>
          enter('visitor_pass', pass.id, n % 2 ? otherToken : guard()),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      for (const r of results.filter((r) => r.status !== 201)) {
        expect(r.status).toBe(409);
        expect(err(r)).toMatchObject({
          code: 'GATE_ENTRY_REFUSED',
          params: { reason: 'used' },
        });
      }
      expect(await entries(pass.id)).toBe(3);
      expect(
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.visitorPass.findUniqueOrThrow({
            where: { id: pass.id },
          }),
        ),
      ).toMatchObject({
        entriesUsed: 3,
        status: 'used',
        codeHash: null,
        qrTokenHash: null,
      });
    }
  });

  it('the pass cap holds under concurrent creation', async () => {
    const unit = await w.helpers.unit(w.a);
    const host = await w.helpers.resident(w.a, [unit.id]);
    const token = await w.tokenFor(w.a, host.id, 'resident');
    await call(w, 'PATCH', '/settings', {
      token: w.a.tokens.manager,
      body: { maxActiveVisitorPasses: 3 },
    }).expect(200);
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          call(w, 'POST', `/units/${unit.id}/visitor-passes`, {
            token,
            body: passBody(),
          }),
        ),
      );
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, 201, 201, 409, 409, 409]);
      const active = await w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.visitorPass.count({
          where: { unitId: unit.id, status: 'active' },
        }),
      );
      expect(active).toBe(3);
    } finally {
      await call(w, 'PATCH', '/settings', {
        token: w.a.tokens.manager,
        body: { maxActiveVisitorPasses: 50 },
      }).expect(200);
    }
  });

  it('one guard starting two shifts at once: one shift', async () => {
    const g = await gateHelpers(h).guard(w.a);
    const token = await w.tokenFor(w.a, g.id, 'staff');
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        call(w, 'POST', '/gate/shifts/start', {
          token,
          body: { gateId: w.a.gateId },
        }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    for (const r of results.filter((x) => x.status === 409))
      expect(err(r).code).toBe('SHIFT_ALREADY_OPEN');
  });

  /**
   * Every subject type locks its own row, and nothing falls through to
   * another table (ADR 0049 turned the last `else` into an explicit case
   * and the default into a programming error). Held by one transaction, the
   * row is probed from another connection with NOWAIT.
   */
  describe('every subject type locks its own row', () => {
    let probe: Client;
    beforeAll(async () => {
      probe = new Client({
        connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
      });
      await probe.connect();
    });
    afterAll(() => probe.end());

    /** Whether the row can be taken `mode` right now (NOWAIT). */
    const free = async (table: string, id: string, mode: string) => {
      try {
        await probe.query('BEGIN');
        await probe.query(
          `SELECT id FROM ${table} WHERE id = $1 FOR ${mode} NOWAIT`,
          [id],
        );
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === '55P03') return false;
        throw e;
      } finally {
        await probe.query('ROLLBACK');
      }
    };
    const holding = async (
      type: GateSubjectType,
      id: string,
      check: () => Promise<void>,
    ) =>
      w.helpers.asManager(w.b, () =>
        h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
          await h.moduleRef.get(EntriesService).lockSubject(tx, type, id);
          await check();
        }),
      );

    it.each([
      ['visitor_pass', 'visitor_passes', (x: World) => x.bPassId],
      [
        'worker_engagement',
        'worker_engagements',
        (x: World) => x.bEngagementId,
      ],
      ['gate_request', 'gate_approval_requests', (x: World) => x.bRequestId],
    ] as const)('%s: its own row, FOR UPDATE', async (type, table, idOf) => {
      const id = idOf(w);
      await holding(type, id, async () => {
        expect(await free(table, id, 'UPDATE')).toBe(false);
        // Not another subject table's row of the same id: there is none.
        for (const other of [
          'visitor_passes',
          'worker_engagements',
          'gate_approval_requests',
        ].filter((t) => t !== table))
          expect(await free(other, id, 'UPDATE')).toBe(true);
      });
      expect(await free(table, id, 'UPDATE')).toBe(true);
    });

    it('a permit’s worker or guest: the permit FOR SHARE, then their own row FOR UPDATE; a move: the permit', async () => {
      await holding('permit_worker', w.bPermitWorkerId, async () => {
        expect(await free('permit_workers', w.bPermitWorkerId, 'UPDATE')).toBe(
          false,
        );
        expect(await free('unit_permits', w.bPermitId, 'SHARE')).toBe(true);
        expect(await free('unit_permits', w.bPermitId, 'UPDATE')).toBe(false);
      });
      await holding('event_guest', w.bPermitGuestId, async () => {
        expect(await free('permit_guests', w.bPermitGuestId, 'UPDATE')).toBe(
          false,
        );
        expect(await free('unit_permits', w.bPermitEventId, 'SHARE')).toBe(
          true,
        );
        expect(await free('unit_permits', w.bPermitEventId, 'UPDATE')).toBe(
          false,
        );
      });
      await holding('move_permit', w.bPermitEventId, async () => {
        expect(await free('unit_permits', w.bPermitEventId, 'UPDATE')).toBe(
          false,
        );
      });
    });

    it('an unknown type is a programming error, never a lock of something else', async () => {
      await expect(
        holding('nothing' as GateSubjectType, w.bPassId, () =>
          Promise.resolve(),
        ),
      ).rejects.toThrow(/Unknown gate subject type nothing/);
      expect(await free('gate_approval_requests', w.bRequestId, 'UPDATE')).toBe(
        true,
      );
    });
  });

  describe('a guard’s write while their shift ends: it waits for the end, then is refused', () => {
    /** A guard of A on a shift of their own, at a gate of their own. */
    const leavingGuard = async () => {
      const duty = await gateHelpers(h).onDuty(w.a);
      const token = await h.tokenFor({
        sub: duty.guardId,
        tid: w.a.tenantId,
        typ: 'staff',
      });
      return { ...duty, token };
    };
    const refused = (res: Response) => {
      expect(res.status).toBe(403);
      expect(err(res).code).toBe('NO_OPEN_SHIFT');
    };
    const request = (id: string) =>
      w.helpers.asManager(w.a, () =>
        w.helpers.prisma.tenant.gateApprovalRequest.findUniqueOrThrow({
          where: { id },
        }),
      );
    const askAs = async (token: string) =>
      (
        (
          await call(w, 'POST', '/gate/approval-requests', {
            token,
            body: { kind: 'uninvited_visitor', unitCode: homeCode },
          }).expect(201)
        ).body as { id: string }
      ).id;

    it('a gate request', async () => {
      const leaving = await leavingGuard();
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          call(w, 'POST', '/gate/approval-requests', {
            token: leaving.token,
            body: { kind: 'uninvited_visitor', unitCode: homeCode },
          }),
        ),
      );
      expect(
        await w.helpers.asManager(w.a, () =>
          w.helpers.prisma.tenant.gateApprovalRequest.count({
            where: { shiftId: leaving.shiftId },
          }),
        ),
      ).toBe(0);
    });

    it('a request’s withdrawal', async () => {
      const leaving = await leavingGuard();
      const id = await askAs(leaving.token);
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          call(w, 'POST', `/gate/approval-requests/${id}/withdraw`, {
            token: leaving.token,
          }),
        ),
      );
      expect((await request(id)).status).toBe('pending');
    });

    it('a standing instruction applied', async () => {
      const leaving = await leavingGuard();
      const made = await call(
        w,
        'POST',
        `/units/${w.a.homeUnitId}/standing-instructions`,
        {
          token: w.a.tokens.owner,
          body: { description: 'Shift-end race', action: 'never_allow' },
        },
      ).expect(201);
      const id = await askAs(leaving.token);
      refused(
        await whileShiftEnds(leaving.shiftId, () =>
          call(w, 'POST', `/gate/approval-requests/${id}/apply-instruction`, {
            token: leaving.token,
            body: { instructionId: (made.body as { id: string }).id },
          }),
        ),
      );
      expect((await request(id)).status).toBe('pending');
    });
  });
});
