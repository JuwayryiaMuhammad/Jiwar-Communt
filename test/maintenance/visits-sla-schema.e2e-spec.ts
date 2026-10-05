import { Client } from 'pg';
import { newId } from '../../src/core/common/uuid';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';

/**
 * ADR 0034: what the visit and SLA tables refuse by themselves, whatever
 * the service says. Run as jiwar_app inside a tenant, like the app, each
 * attempt in a transaction that is always rolled back.
 */
describe('Visit and SLA tables — CHECKs and indexes', () => {
  let h: DbHarness;
  let app: Client;
  let tenantId: string;
  let ticketId: string;
  let technicianId: string;
  let residentId: string;

  beforeAll(async () => {
    h = await createDbHarness();
    tenantId = await createTenant(h, 'Visit schema');
    const unit = await createUnit(h, tenantId);
    residentId = (await createAccountRow(h, tenantId, 'resident')).id;
    technicianId = (await createAccountRow(h, tenantId, 'staff')).id;
    ticketId = newId();
    await h.asTenant(tenantId, () =>
      h.tenantTx.withTenantTx(async (tx) => {
        const category = await tx.ticketCategory.findFirstOrThrow({
          where: { key: 'plumbing' },
        });
        await tx.ticket.create({
          data: {
            id: ticketId,
            tenantId,
            number: 1,
            unitId: unit.id,
            categoryId: category.id,
            createdById: residentId,
            reporterId: residentId,
            priority: 'normal',
            description: 'Fixture',
          },
        });
      }),
    );
    app = new Client({ connectionString: process.env.DATABASE_URL });
    await app.connect();
  });

  afterAll(async () => {
    await app.end();
    await h.close();
  });

  /** Runs every statement in one transaction that is always rolled back. */
  async function attempt(...steps: [string, unknown[]][]) {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      for (const [sql, params] of steps) await app.query(sql, params);
    } finally {
      await app.query('ROLLBACK');
    }
  }

  const COLUMNS = [
    'status',
    'starts_at',
    'ends_at',
    'proposed_by_side',
    'confirmed_at',
    'confirmed_by_account_id',
    'absence_entry_approved',
    'consent_by_account_id',
    'consent_at',
    'receiver_kind',
    'receiver_account_id',
    'arrived_at',
    'finished_at',
    'cancelled_at',
    'cancel_reason_code',
    'cancelled_by_side',
    'cancelled_by_account_id',
    'late_notified_at',
  ] as const;
  type Visit = Partial<Record<(typeof COLUMNS)[number], unknown>>;

  const START = '2030-01-01T10:00:00Z';
  const END = '2030-01-01T12:00:00Z';

  /** A proposed visit, with `over` replacing columns. */
  function visit(over: Visit = {}, id = newId()): [string, unknown[]] {
    const row: Visit = {
      status: 'proposed',
      starts_at: START,
      ends_at: END,
      proposed_by_side: 'technician',
      confirmed_at: null,
      confirmed_by_account_id: null,
      absence_entry_approved: false,
      consent_by_account_id: null,
      consent_at: null,
      receiver_kind: null,
      receiver_account_id: null,
      arrived_at: null,
      finished_at: null,
      cancelled_at: null,
      cancel_reason_code: null,
      cancelled_by_side: null,
      cancelled_by_account_id: null,
      late_notified_at: null,
      ...over,
    };
    const values = COLUMNS.map((c) => row[c]);
    return [
      `INSERT INTO ticket_visits (id, tenant_id, ticket_id, cycle,
         technician_account_id, proposed_by_account_id, updated_at,
         ${COLUMNS.join(', ')})
       VALUES ($1, $2, $3, 1, $4, $4, now(),
         ${COLUMNS.map((c, i) => `$${i + 5}${cast(c)}`).join(', ')})`,
      [id, tenantId, ticketId, technicianId, ...values],
    ];
  }

  function cast(c: string): string {
    if (c === 'status') return '::visit_status';
    if (c === 'proposed_by_side' || c === 'cancelled_by_side')
      return '::visit_side';
    if (c === 'receiver_kind') return '::visit_receiver_kind';
    return '';
  }

  const confirmed = (over: Visit = {}): Visit => ({
    status: 'confirmed',
    confirmed_at: '2029-12-01T00:00:00Z',
    confirmed_by_account_id: residentId,
    ...over,
  });

  describe('ticket_visits', () => {
    it('accepts a proposed visit and a confirmed one with consent and a receiver', async () => {
      await expect(attempt(visit())).resolves.toBeUndefined();
      await expect(
        attempt(
          visit(
            confirmed({
              absence_entry_approved: true,
              consent_by_account_id: residentId,
              consent_at: '2029-12-02T00:00:00Z',
              receiver_kind: 'household',
              receiver_account_id: residentId,
            }),
          ),
        ),
      ).resolves.toBeUndefined();
    });

    it('a window ends after it starts and lasts at most four hours', async () => {
      await expect(attempt(visit({ ends_at: START }))).rejects.toThrow(
        /ticket_visits_window/,
      );
      await expect(
        attempt(visit({ ends_at: '2030-01-01T14:00:01Z' })),
      ).rejects.toThrow(/ticket_visits_window/);
      await expect(
        attempt(visit({ ends_at: '2030-01-01T14:00:00Z' })),
      ).resolves.toBeUndefined();
    });

    it('nobody proposes as the system', async () => {
      await expect(
        attempt(visit({ proposed_by_side: 'system' })),
      ).rejects.toThrow(/proposer_side/);
    });

    it('at most one active visit per ticket, in the database', async () => {
      await expect(attempt(visit(), visit(confirmed()))).rejects.toThrow(
        /ticket_visits_one_active_per_ticket/,
      );
      // An ended one does not count.
      await expect(
        attempt(
          visit({
            status: 'cancelled',
            cancelled_at: START,
            cancel_reason_code: 'other',
            cancelled_by_side: 'system',
          }),
          visit(),
        ),
      ).resolves.toBeUndefined();
    });

    it('consent needs who and when, on a confirmed visit only (the NULL trap)', async () => {
      await expect(
        attempt(visit(confirmed({ absence_entry_approved: true }))),
      ).rejects.toThrow(/consent_shape/);
      await expect(
        attempt(
          visit(
            confirmed({
              absence_entry_approved: false,
              consent_by_account_id: residentId,
              consent_at: START,
            }),
          ),
        ),
      ).rejects.toThrow(/consent_shape/);
      await expect(
        attempt(
          visit({
            absence_entry_approved: true,
            consent_by_account_id: residentId,
            consent_at: START,
          }),
        ),
      ).rejects.toThrow(/consent_shape/);
    });

    it('a receiver has one kind and one id, and no kind means no id (the NULL trap)', async () => {
      await expect(
        attempt(visit(confirmed({ receiver_account_id: residentId }))),
      ).rejects.toThrow(/receiver_shape/);
      await expect(
        attempt(visit(confirmed({ receiver_kind: 'worker' }))),
      ).rejects.toThrow(/receiver_shape/);
      await expect(
        attempt(
          visit({
            receiver_kind: 'household',
            receiver_account_id: residentId,
          }),
        ),
      ).rejects.toThrow(/receiver_shape/);
    });

    it('an arrival, an end and a confirmation leave their times', async () => {
      await expect(
        attempt(visit(confirmed({ status: 'arrived' }))),
      ).rejects.toThrow(/arrived_shape/);
      await expect(
        attempt(visit(confirmed({ status: 'done', arrived_at: START }))),
      ).rejects.toThrow(/finished_shape/);
      await expect(attempt(visit({ status: 'confirmed' }))).rejects.toThrow(
        /confirmed_shape/,
      );
    });

    it('a cancellation has a code and a side; the system names nobody (the NULL trap)', async () => {
      const cancelled = (over: Visit) =>
        visit({
          status: 'cancelled',
          cancelled_at: START,
          cancel_reason_code: 'other',
          cancelled_by_side: 'resident',
          cancelled_by_account_id: residentId,
          ...over,
        });
      await expect(attempt(cancelled({}))).resolves.toBeUndefined();
      await expect(
        attempt(cancelled({ cancel_reason_code: null })),
      ).rejects.toThrow(/cancelled_shape/);
      await expect(
        attempt(cancelled({ cancelled_by_side: null })),
      ).rejects.toThrow(/cancelled_shape/);
      await expect(
        attempt(cancelled({ cancelled_by_side: 'system' })),
      ).rejects.toThrow(/cancelled_shape/);
      await expect(
        attempt(cancelled({ cancelled_by_account_id: null })),
      ).rejects.toThrow(/cancelled_shape/);
      // A counter-proposal ends the old one without a code.
      await expect(
        attempt(cancelled({ status: 'rescheduled', cancel_reason_code: null })),
      ).resolves.toBeUndefined();
    });

    it('a late notice is for a confirmed visit', async () => {
      await expect(attempt(visit({ late_notified_at: START }))).rejects.toThrow(
        /late_shape/,
      );
    });
  });

  describe('ticket_visit_events', () => {
    const event = (side: string, actor: string | null): [string, unknown[]] => [
      `INSERT INTO ticket_visit_events (id, tenant_id, visit_id, ticket_id,
         kind, actor_side, actor_account_id, at)
       VALUES ($1, $2, $3, $4, 'cancelled', $5::visit_side, $6, now())`,
      [newId(), tenantId, newId(), ticketId, side, actor],
    ];

    it('the system names nobody, a person always names themselves', async () => {
      await expect(attempt(event('system', null))).resolves.toBeUndefined();
      await expect(
        attempt(event('resident', residentId)),
      ).resolves.toBeUndefined();
      await expect(attempt(event('system', residentId))).rejects.toThrow(
        /actor_shape/,
      );
      await expect(attempt(event('resident', null))).rejects.toThrow(
        /actor_shape/,
      );
    });
  });

  describe('maintenance_sla_settings and sla_targets', () => {
    it('an enabled SLA has an activation time', async () => {
      await expect(
        attempt([
          `UPDATE maintenance_sla_settings SET sla_enabled = true, enabled_at = NULL`,
          [],
        ]),
      ).rejects.toThrow(/enabled_shape/);
    });

    it('targets stay in range, response before resolution', async () => {
      const set = (
        response: number,
        resolution: number,
      ): [string, unknown[]] => [
        `UPDATE sla_targets SET response_minutes = $1, resolution_minutes = $2`,
        [response, resolution],
      ];
      await expect(attempt(set(4, 100))).rejects.toThrow(/sla_targets_ranges/);
      await expect(attempt(set(60, 43201))).rejects.toThrow(
        /sla_targets_ranges/,
      );
      await expect(attempt(set(120, 60))).rejects.toThrow(/sla_targets_ranges/);
      await expect(attempt(set(60, 60))).resolves.toBeUndefined();
    });
  });

  describe('ticket_sla_events', () => {
    const ev = (
      seq: number,
      kind: string,
      reason: string | null = null,
      clock = 'resolution',
    ): [string, unknown[]] => [
      `INSERT INTO ticket_sla_events (id, tenant_id, ticket_id, cycle, clock,
         seq, kind, at, target_minutes, reason_code)
       VALUES ($1, $2, $3, 1, $4::sla_clock, $5, $6::sla_event_kind, now(), 60, $7)`,
      [newId(), tenantId, ticketId, clock, seq, kind, reason],
    ];

    it('a clock starts at seq 1, and only then', async () => {
      await expect(attempt(ev(1, 'started'))).resolves.toBeUndefined();
      await expect(attempt(ev(2, 'started'))).rejects.toThrow(
        /ticket_sla_events_shape/,
      );
      await expect(attempt(ev(1, 'paused', 'awaiting_parts'))).rejects.toThrow(
        /ticket_sla_events_shape/,
      );
    });

    it('a pause, a retarget and a stop carry a code', async () => {
      for (const kind of ['paused', 'retargeted', 'stopped'])
        await expect(attempt(ev(1, 'started'), ev(2, kind))).rejects.toThrow(
          /reason_shape/,
        );
      await expect(
        attempt(ev(1, 'started'), ev(2, 'paused', 'Not A Code')),
      ).rejects.toThrow(/reason_shape/);
    });

    it('one start and one end per clock: never met and breached both', async () => {
      await expect(attempt(ev(1, 'started'), ev(1, 'started'))).rejects.toThrow(
        /ticket_sla_events_seq_key|ticket_sla_events_one_start/,
      );
      await expect(
        attempt(ev(1, 'started'), ev(2, 'met'), ev(3, 'breached')),
      ).rejects.toThrow(/ticket_sla_events_one_end/);
      await expect(
        attempt(
          ev(1, 'started'),
          ev(2, 'met'),
          ev(1, 'started', null, 'response'),
          ev(2, 'breached', null, 'response'),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('ticket_sla_clocks', () => {
    const clock = (
      state: string,
      due: string | null,
      paused: string | null,
      ended: string | null,
    ): [string, unknown[]] => [
      `INSERT INTO ticket_sla_clocks (tenant_id, ticket_id, cycle, clock, state,
         target_minutes, started_at, due_at, paused_at, ended_at, last_seq, updated_at)
       VALUES ($1, $2, 1, 'response', $3::sla_clock_state, 60, now(), $4, $5, $6, 1, now())`,
      [tenantId, ticketId, state, due, paused, ended],
    ];

    it('a running clock has a due time, a paused one a pause, an ended one an end', async () => {
      await expect(
        attempt(clock('running', START, null, null)),
      ).resolves.toBeUndefined();
      await expect(attempt(clock('running', null, null, null))).rejects.toThrow(
        /ticket_sla_clocks_shape/,
      );
      await expect(
        attempt(clock('paused', START, START, null)),
      ).rejects.toThrow(/ticket_sla_clocks_shape/);
      await expect(attempt(clock('met', null, null, null))).rejects.toThrow(
        /ticket_sla_clocks_shape/,
      );
      await expect(
        attempt(clock('breached', null, null, START)),
      ).resolves.toBeUndefined();
    });
  });
});
