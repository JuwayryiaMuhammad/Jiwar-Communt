import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { dbClock } from './compound-clock';

/** A meeting of a term, held (so it takes action items); its id. */
export async function heldMeetingRow(
  tx: TenantTxClient,
  r: { tenantId: string; termId: string; createdById: string; number?: number },
): Promise<string> {
  const id = newId();
  const now = dbClock();
  await tx.boardMeeting.create({
    data: {
      id,
      tenantId: r.tenantId,
      termId: r.termId,
      number: r.number ?? Number.parseInt(id.slice(-6), 16),
      kind: 'regular',
      title: 'A meeting row',
      scheduledAt: now,
      status: 'held',
      heldAt: now,
      seatedCount: 1,
      presentCount: 1,
      quorate: true,
      authorSide: 'board',
      createdById: r.createdById,
      createdAt: now,
    },
  });
  return id;
}

/** A meeting of a term, scheduled (so its agenda may be written); its id. */
export async function scheduledMeetingRow(
  tx: TenantTxClient,
  r: { tenantId: string; termId: string; createdById: string },
): Promise<string> {
  const id = newId();
  const now = dbClock();
  await tx.boardMeeting.create({
    data: {
      id,
      tenantId: r.tenantId,
      termId: r.termId,
      number: Number.parseInt(id.slice(-6), 16),
      kind: 'regular',
      title: 'A scheduled meeting row',
      scheduledAt: now,
      authorSide: 'board',
      createdById: r.createdById,
      createdAt: now,
    },
  });
  return id;
}

/** An open action item of a held meeting; its id. */
export async function meetingActionRow(
  tx: TenantTxClient,
  r: { tenantId: string; meetingId: string; ownerId: string },
): Promise<string> {
  const id = newId();
  await tx.boardMeetingAction.create({
    data: {
      id,
      tenantId: r.tenantId,
      meetingId: r.meetingId,
      title: 'An action row',
      ownerId: r.ownerId,
      dueOn: new Date(Date.UTC(2099, 0, 1)),
      createdById: r.ownerId,
      createdAt: dbClock(),
    },
  });
  return id;
}
