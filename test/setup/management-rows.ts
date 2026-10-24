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

/**
 * A pending decision appeal (ADR 0059) of a decision that does not exist:
 * enough for the schema and isolation suites, which never ask its domain.
 */
export async function decisionAppealRow(
  tx: TenantTxClient,
  r: { tenantId: string; unitId: string; appellantId: string },
): Promise<string> {
  const id = newId();
  const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
    INSERT INTO decision_appeal_counters (tenant_id, last_number)
    VALUES (${r.tenantId}::uuid, 1)
    ON CONFLICT (tenant_id) DO UPDATE
      SET last_number = decision_appeal_counters.last_number + 1
    RETURNING last_number AS number`;
  const at = new Date();
  await tx.decisionAppeal.create({
    data: {
      id,
      tenantId: r.tenantId,
      number,
      kind: 'permit_rejection',
      subjectId: newId(),
      unitId: r.unitId,
      appellantId: r.appellantId,
      grounds: 'The work was within the hours.',
      decisionAt: at,
      lodgedAt: at,
    },
  });
  return id;
}
