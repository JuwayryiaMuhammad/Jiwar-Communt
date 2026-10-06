import {
  AccountDeletionService,
  DELETION_SWEEP,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { WorkersService } from '../../src/community/workers/workers.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import { gateHelpers } from '../setup/gate';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

const DAY = 86_400_000;
const HOLD = { code: 'litigation', text: 'Keep it' };

/**
 * Account deletion (ADR 0036): blockers on request and again at execution,
 * a 14-day cooling-off with a reminder two days before, execution by the
 * sweep — or the managers' queue when something blocks it — and the races
 * around it.
 */
describe('Account deletion', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let deletion: AccountDeletionService;
  let sweep: SweepRunner;
  let c: Compound;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    deletion = h.moduleRef.get(AccountDeletionService);
    sweep = h.moduleRef.get(SweepRunner);
    c = await x.compound('Deletion Court');
  });

  afterAll(() => h.close());

  const asResident = <T>(id: string, fn: () => Promise<T>) =>
    x.as(c, { id, type: 'resident' }, fn);
  const later = (days: number, extraMs = 60_000) =>
    new Date(Date.now() + days * DAY + extraMs);

  /** A unit with its owner (the primary) and a tenant beside them. */
  async function household() {
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    const tenant = await x.resident(c, [unit.id], 'tenant');
    return { unitId: unit.id, owner, tenant };
  }

  const ask = (id: string) =>
    asResident(id, () => deletion.requestDeletion('DELETE'));
  const refusal = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { response?: { code?: string; params?: { blockers?: string[] } } }) =>
        e.response,
    );
  const account = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.account.findUniqueOrThrow({ where: { id } }),
    );
  const request = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.findUniqueOrThrow({
        where: { id },
      }),
    );
  const kinds = (accountId: string, kind: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.notification.findMany({ where: { accountId, kind } }),
    );
  /** Past its cooling-off, as if 15 days had gone by. */
  const due = (id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.update({
        where: { id },
        data: {
          requestedAt: new Date(Date.now() - 15 * DAY),
          effectiveAt: new Date(Date.now() - DAY),
        },
      }),
    );

  // --------------------------------------------------------------------------
  describe('blockers on request', () => {
    it('a primary resident', async () => {
      const { owner } = await household();
      expect(await refusal(ask(owner.id))).toMatchObject({
        code: 'DELETION_BLOCKED',
        params: { blockers: ['primary_resident'] },
      });
    });

    it('an active staff role', async () => {
      const guard = await gateHelpers(h).guard(c);
      expect(
        await refusal(
          x.as(c, { id: guard.id, type: 'staff' }, () =>
            deletion.requestDeletion('DELETE'),
          ),
        ),
      ).toMatchObject({ params: { blockers: ['active_staff_role'] } });
    });

    it('a legal hold', async () => {
      const { tenant } = await household();
      await x.asManager(c, () => deletion.placeLegalHold(tenant.id, HOLD));
      expect(await refusal(ask(tenant.id))).toMatchObject({
        params: { blockers: ['legal_hold'] },
      });
    });

    it('open worker obligations: a worker with a code, or a wage unsettled', async () => {
      const { unitId, tenant } = await household();
      const workers = h.moduleRef.get(WorkersService);
      const reg = await asResident(tenant.id, () =>
        workers.register(unitId, {
          fullName: 'Worker Blocker',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
          phone: uniquePhone(),
          capacity: 'live_in',
        }),
      );
      // Pending review, no code yet: nobody worked.
      expect(await refusal(ask(tenant.id))).toBeNull();
      await asResident(tenant.id, () => deletion.cancelDeletion());
      await x.asManager(c, () => workers.review(reg.engagementId, 'approve'));
      expect(await refusal(ask(tenant.id))).toMatchObject({
        params: { blockers: ['open_worker_obligations'] },
      });
      // Ended: the wage to settle stays open, and still blocks.
      await asResident(tenant.id, () =>
        workers.end(reg.engagementId, {
          code: 'work_finished',
          text: 'Done',
        }),
      );
      expect(await refusal(ask(tenant.id))).toMatchObject({
        params: { blockers: ['open_worker_obligations'] },
      });
      // Settled by payroll: no longer.
      await x.asManager(c, () =>
        x.prisma.tenant.workerWageObligation.updateMany({
          where: { engagementId: reg.engagementId },
          data: { settledAt: new Date(), settledById: c.managerId },
        }),
      );
      expect(await refusal(ask(tenant.id))).toBeNull();
    });

    it('none for a tenant beside the owner: filed, told, critical', async () => {
      const { tenant } = await household();
      const req = await ask(tenant.id);
      expect(req).toMatchObject({
        status: 'pending',
        assisted: false,
        blockers: [],
      });
      expect(req.effectiveAt.getTime() - req.requestedAt.getTime()).toBe(
        14 * DAY,
      );
      const [n] = await kinds(tenant.id, 'account.deletion_requested');
      expect(n).toMatchObject({ priority: 'critical', targetId: req.id });
      expect(n.params).toEqual({ effectiveAt: req.effectiveAt.toISOString() });
    });
  });

  // --------------------------------------------------------------------------
  it('can be cancelled during the cooling-off, and the account keeps working', async () => {
    const { tenant } = await household();
    await ask(tenant.id);
    expect((await account(tenant.id)).status).toBe('active');
    await asResident(tenant.id, () => deletion.cancelDeletion());
    expect(
      await asResident(tenant.id, () => deletion.myDeletionRequest()),
    ).toMatchObject({ status: 'cancelled' });
    // Nothing left for the sweep.
    await sweep.run(DELETION_SWEEP, later(15));
    expect((await account(tenant.id)).status).toBe('active');
  });

  it('is reminded two days before (day 12), once', async () => {
    const { tenant } = await household();
    const req = await ask(tenant.id);
    await sweep.run(DELETION_SWEEP, later(11));
    expect(await kinds(tenant.id, 'account.deletion_reminder')).toEqual([]);
    await sweep.run(DELETION_SWEEP, later(12));
    const [n] = await kinds(tenant.id, 'account.deletion_reminder');
    expect(n).toMatchObject({ priority: 'critical', targetId: req.id });
    expect((await request(req.id)).remindedAt).not.toBeNull();
    await sweep.run(DELETION_SWEEP, later(12, 3_600_000));
    expect(await kinds(tenant.id, 'account.deletion_reminder')).toHaveLength(1);
    const mail = await h.moduleRef.get(GlobalDbService).outboxMessage.findMany({
      where: {
        recipientAccountId: tenant.id,
        templateKey: 'account.deletion_reminder',
      },
    });
    expect(mail).toHaveLength(1);
  });

  it('runs the erasure after 14 days, as the system', async () => {
    const { tenant } = await household();
    const req = await ask(tenant.id);
    await sweep.run(DELETION_SWEEP, later(13, 23 * 3_600_000));
    expect((await account(tenant.id)).status).toBe('active');
    await sweep.run(DELETION_SWEEP, later(14));
    expect(await account(tenant.id)).toMatchObject({
      status: 'erased',
      fullName: null,
      email: null,
    });
    expect(await request(req.id)).toMatchObject({
      status: 'completed',
      completedById: null,
    });
    const [erased] = await auditReaders(h).tenant(c.tenantId, {
      action: 'account.erased',
      targetId: tenant.id,
    });
    expect(erased).toMatchObject({ actorType: 'system', actorId: null });
  });

  it('a blocker that appeared during the cooling-off moves it to the managers’ queue', async () => {
    const { tenant } = await household();
    const req = await ask(tenant.id);
    const holdId = await x.asManager(c, () =>
      deletion.placeLegalHold(tenant.id, HOLD),
    );
    await sweep.run(DELETION_SWEEP, later(15));
    expect(await request(req.id)).toMatchObject({
      status: 'queued',
      blockerCodes: ['legal_hold'],
    });
    expect((await account(tenant.id)).status).toBe('active');
    const [delayed] = await kinds(tenant.id, 'account.deletion_delayed');
    expect(delayed).toMatchObject({
      priority: 'critical',
      params: { blockers: 'legal_hold' },
    });
    const [queued] = await kinds(c.managerId, 'account.deletion_queued');
    expect(queued).toMatchObject({ targetId: req.id });

    // The queue: listed with its blockers; refused while blocked.
    const open = await x.asManager(c, () => deletion.pendingErasures());
    expect(open.items.find((i) => i.id === req.id)).toMatchObject({
      status: 'queued',
      blockers: ['legal_hold'],
    });
    expect(
      await codeOf(
        x.asManager(c, () => deletion.erase(req.id, scopePhrase(tenant.id))),
      ),
    ).toBe('LEGAL_HOLD_ACTIVE');
    // The sweep leaves a queued request alone.
    await sweep.run(DELETION_SWEEP, later(16));
    expect((await request(req.id)).status).toBe('queued');

    await x.asManager(c, () =>
      deletion.releaseLegalHold(holdId, { code: 'resolved', text: 'Done' }),
    );
    await x.asManager(c, () => deletion.erase(req.id, scopePhrase(tenant.id)));
    expect((await account(tenant.id)).status).toBe('erased');
  });

  it('a manager closes a queued request with a reason code; the account is told', async () => {
    const { tenant } = await household();
    const req = await ask(tenant.id);
    await x.asManager(c, () => deletion.placeLegalHold(tenant.id, HOLD));
    await sweep.run(DELETION_SWEEP, later(15));
    expect(
      await codeOf(x.asManager(c, () => deletion.closeQueued(req.id, 'nope'))),
    ).toBe('VALIDATION_FAILED');
    await x.asManager(c, () =>
      deletion.closeQueued(req.id, 'blockers_unresolved'),
    );
    expect(await request(req.id)).toMatchObject({
      status: 'closed',
      closeReasonCode: 'blockers_unresolved',
      closedById: c.managerId,
    });
    const [n] = await kinds(tenant.id, 'account.deletion_closed');
    expect(n.params).toEqual({ reason: 'blockers_unresolved' });
    // Closed, not open: another request may be filed once it is clear.
    expect(
      await codeOf(x.asManager(c, () => deletion.closeQueued(req.id, 'other'))),
    ).toBe('DELETION_REQUEST_NOT_FOUND');
  });

  it('a family member’s deletion tells the unit’s primary, without a reason', async () => {
    const unit = await x.unit(c);
    const primary = await x.resident(c, [unit.id]);
    const family = await x.joinFamily(c, unit.id, primary);
    await x.as(c, { id: family.id, type: 'family' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await sweep.run(DELETION_SWEEP, later(15));
    expect((await account(family.id)).status).toBe('erased');
    const [n] = await kinds(primary.id, 'household.member_account_deleted');
    const code = (
      await x.asManager(c, () =>
        x.prisma.tenant.unit.findUniqueOrThrow({ where: { id: unit.id } }),
      )
    ).code;
    expect(n.params).toEqual({ unitCode: code });
    const [mail] = await h.moduleRef
      .get(GlobalDbService)
      .outboxMessage.findMany({
        where: {
          recipientAccountId: primary.id,
          templateKey: 'household.member_account_deleted',
        },
      });
    expect(Object.keys(mail.params as object).sort()).toEqual([
      'compoundName',
      'unitCode',
    ]);
  });

  // --------------------------------------------------------------------------
  describe('races', () => {
    const ROUNDS = 5;

    it('execution against becoming primary: either queued as a primary, or erased and the change refused', async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const { unitId, tenant } = await household();
        const req = await ask(tenant.id);
        await due(req.id);
        const [primary] = await Promise.allSettled([
          x.asManager(c, () => x.residents.setPrimary(unitId, tenant.id)),
          sweep.run(DELETION_SWEEP),
        ]);
        const r = await request(req.id);
        if (primary.status === 'fulfilled') {
          expect(r).toMatchObject({
            status: 'queued',
            blockerCodes: ['primary_resident'],
          });
          expect((await account(tenant.id)).status).toBe('active');
        } else {
          expect(r.status).toBe('completed');
          expect((await account(tenant.id)).status).toBe('erased');
          const active = (await x.occupancies(c, unitId)).filter(
            (o) => o.accountId === tenant.id && o.status === 'active',
          );
          expect(active).toEqual([]);
        }
      }
    });

    it('execution against a transfer of ownership to the account: queued as a primary, or erased and the transfer refused — never a deadlock', async () => {
      for (let i = 0; i < ROUNDS; i++) {
        // The buyer already lives in the unit as a tenant, so the erasure
        // locks this very unit while the transfer points at the buyer: the
        // two would cross without the accounts-first order.
        const { unitId, tenant } = await household();
        const req = await ask(tenant.id);
        await due(req.id);
        const [transfer] = await Promise.allSettled([
          x.asManager(c, () =>
            x.residents.transferOwnership(
              unitId,
              { toAccountId: tenant.id },
              { code: 'unit_changed_hands', text: 'Sold' },
            ),
          ),
          sweep.run(DELETION_SWEEP),
        ]);
        const r = await request(req.id);
        if (transfer.status === 'fulfilled') {
          expect(r).toMatchObject({
            status: 'queued',
            blockerCodes: ['primary_resident'],
          });
          expect((await account(tenant.id)).status).toBe('active');
        } else {
          const refused = transfer.reason as {
            response?: { code?: string };
          };
          expect(refused.response?.code).toBe('ACCOUNT_NOT_FOUND');
          expect(r.status).toBe('completed');
          expect((await account(tenant.id)).status).toBe('erased');
        }
      }
    });

    it('execution against a staff account turned active again: either queued or erased', async () => {
      const accounts = h.moduleRef.get(AccountsService);
      for (let i = 0; i < ROUNDS; i++) {
        const guard = await gateHelpers(h).guard(c);
        await x.asManager(c, () =>
          accounts.updateStatus(guard.id, { status: 'inactive' }),
        );
        const req = await x.as(c, { id: guard.id, type: 'staff' }, () =>
          deletion.requestDeletion('DELETE'),
        );
        await due(req.id);
        const [active] = await Promise.allSettled([
          x.asManager(c, () =>
            accounts.updateStatus(guard.id, { status: 'active' }),
          ),
          sweep.run(DELETION_SWEEP),
        ]);
        const r = await request(req.id);
        if (active.status === 'fulfilled') {
          expect(r).toMatchObject({
            status: 'queued',
            blockerCodes: ['active_staff_role'],
          });
          expect((await account(guard.id)).status).toBe('active');
        } else {
          expect(r.status).toBe('completed');
          // Never `active` over a tombstone.
          expect(await account(guard.id)).toMatchObject({
            status: 'erased',
            fullName: null,
          });
        }
      }
    });

    it('cancel against execution: exactly one wins', async () => {
      for (let i = 0; i < ROUNDS; i++) {
        const { tenant } = await household();
        const req = await ask(tenant.id);
        // The cancel still sees its cooling-off; the execution runs as if
        // it were over (its `now` is past `effectiveAt`).
        const [cancel] = await Promise.allSettled([
          asResident(tenant.id, () => deletion.cancelDeletion()),
          sweep.run(DELETION_SWEEP, later(14)),
        ]);
        const r = await request(req.id);
        if (cancel.status === 'fulfilled') {
          expect(r.status).toBe('cancelled');
          expect((await account(tenant.id)).status).toBe('active');
        } else {
          expect(r.status).toBe('completed');
          expect((await account(tenant.id)).status).toBe('erased');
          expect(
            (cancel.reason as { response?: { code?: string } }).response?.code,
          ).toBe('DELETION_REQUEST_NOT_FOUND');
        }
      }
    });
  });

  it('an assisted request shape is held by the database', async () => {
    const { tenant } = await household();
    // Assisted without a reason, or someone else's own request: refused.
    await expect(
      x.asManager(c, () =>
        x.prisma.tenant.accountDeletionRequest.create({
          data: {
            id: newId(),
            tenantId: c.tenantId,
            accountId: tenant.id,
            requestedById: c.managerId,
            effectiveAt: later(14),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
