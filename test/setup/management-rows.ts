import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

/**
 * Rows of the management tables written straight into the database, for the
 * suites that test the tables themselves (CHECKs, triggers, RLS). Suites
 * that test behaviour go through the API instead.
 */

let numbers = 9000;

export async function topicRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.managementRequestTopic.create({
    data: {
      id,
      tenantId,
      key: `k_${id.slice(-8)}`,
      nameAr: 'موضوع',
      nameEn: 'Topic',
      targetResponseHours: 24,
    },
  });
  return id;
}

export async function requestRow(
  tx: TenantTxClient,
  row: { tenantId: string; topicId: string; authorId: string },
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.managementRequest.create({
    data: {
      id,
      tenantId: row.tenantId,
      number: numbers++,
      type: 'question',
      topicId: row.topicId,
      authorId: row.authorId,
      cycleStartedAt: now,
      responseDueAt: new Date(now.getTime() + 3_600_000),
      lastActivityAt: now,
    },
  });
  return id;
}

export async function messageRow(
  tx: TenantTxClient,
  row: { tenantId: string; requestId: string; senderId: string },
): Promise<string> {
  const id = newId();
  await tx.managementRequestMessage.create({
    data: {
      id,
      tenantId: row.tenantId,
      requestId: row.requestId,
      senderId: row.senderId,
      senderSide: 'resident',
      body: 'Hello',
      cycle: 1,
    },
  });
  return id;
}

/** An attached, ready file of the purpose a message takes. */
export async function attachmentFileRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose: 'request_attachment',
      contentType: 'application/pdf',
      sizeBytes: 100,
      status: 'ready',
      uploadExpiresAt: now,
      finalizedAt: now,
      attachedAt: now,
    },
  });
  return id;
}
