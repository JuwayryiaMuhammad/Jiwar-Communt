import { Client } from 'pg';
import { fold, type SlaEventLike } from '../../src/maintenance/sla/sla-fold';
import { required } from './test-env';

// ============================================================================
// The SLA's test time machine (ADR 0034). TEST-ONLY: it rewrites append-only
// history over a superuser connection with `session_replication_role =
// replica`, which skips the immutability triggers. src/ cannot import it
// (eslint.boundaries.cjs, SRC_TO_TEST).
// ============================================================================

async function superuser<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    await db.end();
  }
}

/**
 * Moves a ticket's SLA `minutes` into the past: every event, every clock's
 * times, its status history and its visits' creation, as if it all had
 * happened that long ago. The projection stays the fold of the events. The
 * compound's activation moves back too: a clock never starts before it, and
 * one that seemed to would be taken for an earlier activation's.
 */
export function rewind(ticketId: string, minutes: number): Promise<void> {
  const by = `${minutes} minutes`;
  return superuser(async (db) => {
    await db.query(
      `UPDATE ticket_sla_events SET at = at - $2::interval WHERE ticket_id = $1`,
      [ticketId, by],
    );
    await db.query(
      `UPDATE ticket_sla_clocks
          SET started_at = started_at - $2::interval,
              due_at = due_at - $2::interval,
              paused_at = paused_at - $2::interval,
              ended_at = ended_at - $2::interval
        WHERE ticket_id = $1`,
      [ticketId, by],
    );
    await db.query(
      `UPDATE ticket_status_history SET created_at = created_at - $2::interval
        WHERE ticket_id = $1`,
      [ticketId, by],
    );
    await db.query(
      `UPDATE ticket_visits SET created_at = created_at - $2::interval
        WHERE ticket_id = $1`,
      [ticketId, by],
    );
    await db.query(
      `UPDATE maintenance_sla_settings
          SET enabled_at = enabled_at - $2::interval
        WHERE tenant_id = (SELECT tenant_id FROM tickets WHERE id = $1)`,
      [ticketId, by],
    );
  });
}

/** Moves the compound's SLA activation `minutes` into the past. */
export function rewindActivation(
  tenantId: string,
  minutes: number,
): Promise<void> {
  return superuser(async (db) => {
    await db.query(
      `UPDATE maintenance_sla_settings
          SET enabled_at = enabled_at - $2::interval WHERE tenant_id = $1`,
      [tenantId, `${minutes} minutes`],
    );
  });
}

export interface EventRow {
  ticketId: string;
  cycle: number;
  clock: 'response' | 'resolution';
  seq: number;
  kind: string;
  at: Date;
  targetMinutes: number;
  reasonCode: string | null;
}

export interface ClockRow {
  ticketId: string;
  cycle: number;
  clock: 'response' | 'resolution';
  state: string;
  targetMinutes: number;
  startedAt: Date;
  dueAt: Date | null;
  pausedAt: Date | null;
  endedAt: Date | null;
  lastSeq: number;
}

/** A ticket's SLA events, in order (any compound: superuser). */
export function slaEvents(ticketId: string): Promise<EventRow[]> {
  return superuser(async (db) => {
    const { rows } = await db.query<EventRow>(
      `SELECT ticket_id AS "ticketId", cycle, clock::text AS clock, seq,
              kind::text AS kind, at, target_minutes AS "targetMinutes",
              reason_code AS "reasonCode"
         FROM ticket_sla_events WHERE ticket_id = $1
        ORDER BY cycle, clock, seq`,
      [ticketId],
    );
    return rows;
  });
}

/** A ticket's clocks (any compound: superuser). */
export function slaClocks(ticketId: string): Promise<ClockRow[]> {
  return superuser(async (db) => {
    const { rows } = await db.query<ClockRow>(
      `SELECT ticket_id AS "ticketId", cycle, clock::text AS clock,
              state::text AS state, target_minutes AS "targetMinutes",
              started_at AS "startedAt", due_at AS "dueAt",
              paused_at AS "pausedAt", ended_at AS "endedAt",
              last_seq AS "lastSeq"
         FROM ticket_sla_clocks WHERE ticket_id = $1
        ORDER BY cycle, clock`,
      [ticketId],
    );
    return rows;
  });
}

/**
 * Every clock of the database, rebuilt from its events, next to the stored
 * projection: equal when the projection is what ADR 0034 says it is.
 */
export function rebuildEveryClock(): Promise<{
  rebuilt: Record<string, unknown>[];
  stored: Record<string, unknown>[];
}> {
  return superuser(async (db) => {
    const events = await db.query<EventRow & { tenantId: string }>(
      `SELECT tenant_id AS "tenantId", ticket_id AS "ticketId", cycle,
              clock::text AS clock, seq, kind::text AS kind, at,
              target_minutes AS "targetMinutes"
         FROM ticket_sla_events ORDER BY tenant_id, ticket_id, cycle, clock, seq`,
    );
    const clocks = await db.query<ClockRow & { tenantId: string }>(
      `SELECT tenant_id AS "tenantId", ticket_id AS "ticketId", cycle,
              clock::text AS clock, state::text AS state,
              target_minutes AS "targetMinutes", started_at AS "startedAt",
              due_at AS "dueAt", paused_at AS "pausedAt",
              ended_at AS "endedAt", last_seq AS "lastSeq"
         FROM ticket_sla_clocks ORDER BY tenant_id, ticket_id, cycle, clock`,
    );
    const groups = new Map<string, SlaEventLike[]>();
    for (const e of events.rows) {
      const key = `${e.tenantId}/${e.ticketId}/${e.cycle}/${e.clock}`;
      groups.set(key, [
        ...(groups.get(key) ?? []),
        {
          seq: e.seq,
          kind: e.kind as SlaEventLike['kind'],
          at: e.at,
          targetMinutes: e.targetMinutes,
        },
      ]);
    }
    const rebuilt = [...groups.entries()]
      .map(([key, list]) => ({ key, ...fold(list) }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const stored = clocks.rows
      .map((c) => ({
        key: `${c.tenantId}/${c.ticketId}/${c.cycle}/${c.clock}`,
        state: c.state,
        targetMinutes: c.targetMinutes,
        startedAt: c.startedAt,
        dueAt: c.dueAt,
        pausedAt: c.pausedAt,
        endedAt: c.endedAt,
        lastSeq: c.lastSeq,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    return { rebuilt, stored };
  });
}

/** Sets a compound's status straight in the table (suspension tests). */
export function setTenantStatus(
  tenantId: string,
  status: 'active' | 'suspended',
): Promise<void> {
  return superuser(async (db) => {
    await db.query(`UPDATE tenants SET status = $2 WHERE id = $1`, [
      tenantId,
      status,
    ]);
  });
}
