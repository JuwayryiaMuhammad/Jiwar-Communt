import { randomInt } from 'node:crypto';
import type { NeighbourPostKind, NeighbourThread } from '@prisma/client';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

/**
 * Rows of the neighbours tables written straight into the database, for
 * the suites that test the tables themselves (CHECKs, triggers, RLS).
 * Suites that test behaviour go through the API instead.
 */

// eslint-disable-next-line no-restricted-syntax -- any instant for a raw row: no server code reads its compound day
const DAY = 86_400_000;

export async function categoryRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.neighbourComplaintCategory.create({
    data: {
      id,
      tenantId,
      key: `k_${id.slice(-8)}`,
      nameAr: 'فئة',
      nameEn: 'Category',
    },
  });
  return id;
}

/** A submitted complaint with its filing row. */
export async function complaintRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    authorId: string;
    targetUnitId: string;
    categoryId: string;
    authorUnitId?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.neighbourComplaint.create({
    data: {
      id,
      tenantId: row.tenantId,
      // Unique per compound; the service takes it from the counter.
      number: randomInt(1, 2_000_000_000),
      authorId: row.authorId,
      authorUnitId: row.authorUnitId,
      targetUnitId: row.targetUnitId,
      categoryId: row.categoryId,
      lastActivityAt: new Date(),
    },
  });
  return id;
}

export async function statusChangeRow(
  tx: TenantTxClient,
  row: { tenantId: string; complaintId: string; actorId: string },
): Promise<string> {
  const id = newId();
  await tx.neighbourComplaintStatusChange.create({
    data: {
      id,
      tenantId: row.tenantId,
      complaintId: row.complaintId,
      fromStatus: null,
      toStatus: 'submitted',
      actorId: row.actorId,
      actorSide: 'resident',
    },
  });
  return id;
}

export async function complaintMessageRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    complaintId: string;
    senderId: string;
    thread?: NeighbourThread;
  },
): Promise<string> {
  const id = newId();
  const thread = row.thread ?? 'complainant';
  await tx.neighbourComplaintMessage.create({
    data: {
      id,
      tenantId: row.tenantId,
      complaintId: row.complaintId,
      thread,
      senderId: row.senderId,
      senderSide: thread === 'internal' ? 'staff' : 'resident',
      body: 'Words',
    },
  });
  return id;
}

/** A ready, attached file of a neighbours purpose. */
export async function neighbourFileRow(
  tx: TenantTxClient,
  tenantId: string,
  purpose: 'complaint_evidence' | 'neighbour_post_photo' = 'complaint_evidence',
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose,
      contentType: 'image/png',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}

export async function noticeRow(
  tx: TenantTxClient,
  row: { tenantId: string; complaintId: string; sentById: string },
): Promise<string> {
  const id = newId();
  await tx.neighbourComplaintNotice.create({
    data: {
      id,
      tenantId: row.tenantId,
      complaintId: row.complaintId,
      body: 'Please keep it down.',
      recipientKind: 'household',
      sentById: row.sentById,
    },
  });
  return id;
}

/** An open post of a resident, on its board for a month. */
export async function postRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    authorId: string;
    authorUnitId?: string;
    kind?: NeighbourPostKind;
  },
): Promise<string> {
  const id = newId();
  await tx.neighbourPost.create({
    data: {
      id,
      tenantId: row.tenantId,
      kind: row.kind ?? 'found',
      authorId: row.authorId,
      authorSide: 'resident',
      authorUnitId: row.authorUnitId,
      body: 'A set of keys',
      place: 'Gate 2',
      expiresAt: new Date(Date.now() + 30 * DAY),
    },
  });
  return id;
}

export async function claimRow(
  tx: TenantTxClient,
  row: { tenantId: string; postId: string; claimantId: string },
): Promise<string> {
  const id = newId();
  await tx.neighbourItemClaim.create({
    data: {
      id,
      tenantId: row.tenantId,
      postId: row.postId,
      claimantId: row.claimantId,
      note: 'It is mine',
    },
  });
  return id;
}

export async function conversationRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    postId: string;
    authorId: string;
    responderId: string;
    responderUnitId?: string;
  },
): Promise<string> {
  const id = newId();
  await tx.neighbourConversation.create({
    data: {
      id,
      tenantId: row.tenantId,
      postId: row.postId,
      authorId: row.authorId,
      responderId: row.responderId,
      responderUnitId: row.responderUnitId,
      lastMessageAt: new Date(),
    },
  });
  return id;
}

export async function conversationMessageRow(
  tx: TenantTxClient,
  row: { tenantId: string; conversationId: string; senderId: string },
): Promise<string> {
  const id = newId();
  await tx.neighbourConversationMessage.create({
    data: {
      id,
      tenantId: row.tenantId,
      conversationId: row.conversationId,
      senderId: row.senderId,
      body: 'Words',
    },
  });
  return id;
}

export async function reportRow(
  tx: TenantTxClient,
  row: { tenantId: string; conversationId: string; reporterId: string },
): Promise<string> {
  const id = newId();
  await tx.neighbourConversationReport.create({
    data: {
      id,
      tenantId: row.tenantId,
      conversationId: row.conversationId,
      reporterId: row.reporterId,
      reasonCode: 'spam',
      note: 'Look at this',
    },
  });
  return id;
}

/** An active, non-primary occupancy: what a welcome row points at. */
export async function occupancyRow(
  tx: TenantTxClient,
  row: { tenantId: string; unitId: string; accountId: string },
): Promise<string> {
  const id = newId();
  await tx.unitOccupancy.create({
    data: {
      id,
      tenantId: row.tenantId,
      unitId: row.unitId,
      accountId: row.accountId,
      occupancyType: 'owner',
      createdById: row.accountId,
    },
  });
  return id;
}
