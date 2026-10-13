import { randomBytes } from 'node:crypto';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';

/**
 * Rows of the community life's tables written straight into the database,
 * for the suites that test the tables themselves (CHECKs, triggers, RLS).
 * Suites that test behaviour go through the API instead.
 */

const HOUR = 3_600_000;

export async function suggestionTopicRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  await tx.suggestionTopic.create({
    data: {
      id,
      tenantId,
      key: `k_${id.slice(-8)}`,
      nameAr: 'موضوع',
      nameEn: 'Topic',
    },
  });
  return id;
}

/** A published general announcement with its first version. */
export async function announcementRow(
  tx: TenantTxClient,
  row: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.announcement.create({
    data: {
      id,
      tenantId: row.tenantId,
      kind: 'general',
      publishAt: new Date(Date.now() - HOUR),
      createdById: row.createdById,
    },
  });
  await versionRow(tx, {
    tenantId: row.tenantId,
    announcementId: id,
    editedById: row.createdById,
    version: 1,
  });
  return id;
}

export async function versionRow(
  tx: TenantTxClient,
  row: {
    tenantId: string;
    announcementId: string;
    editedById: string;
    version: number;
  },
): Promise<string> {
  const id = newId();
  await tx.announcementVersion.create({
    data: {
      id,
      tenantId: row.tenantId,
      announcementId: row.announcementId,
      version: row.version,
      titleEn: 'Title',
      bodyEn: 'Body',
      editedById: row.editedById,
    },
  });
  return id;
}

export async function eventRow(
  tx: TenantTxClient,
  row: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.communityEvent.create({
    data: {
      id,
      tenantId: row.tenantId,
      titleEn: 'Event',
      descriptionEn: 'An event.',
      place: 'The garden',
      startsAt: new Date(Date.now() + 24 * HOUR),
      endsAt: new Date(Date.now() + 26 * HOUR),
      createdById: row.createdById,
    },
  });
  return id;
}

/** An open poll, with its salt; no options, no box. */
export async function pollRow(
  tx: TenantTxClient,
  row: { tenantId: string; createdById: string },
): Promise<string> {
  const id = newId();
  await tx.poll.create({
    data: {
      id,
      tenantId: row.tenantId,
      questionEn: 'Question?',
      opensAt: new Date(Date.now() - HOUR),
      closesAt: new Date(Date.now() + 24 * HOUR),
      ballotSalt: new Uint8Array(randomBytes(32)),
      createdById: row.createdById,
    },
  });
  return id;
}

export async function suggestionRow(
  tx: TenantTxClient,
  row: { tenantId: string; authorId: string; topicId: string },
): Promise<string> {
  const id = newId();
  await tx.suggestion.create({
    data: {
      id,
      tenantId: row.tenantId,
      authorId: row.authorId,
      topicId: row.topicId,
      body: 'A suggestion.',
    },
  });
  return id;
}

/** A finalized community attachment that nobody owns: attached. */
export async function communityFileRow(
  tx: TenantTxClient,
  tenantId: string,
): Promise<string> {
  const id = newId();
  const now = new Date();
  await tx.storedFile.create({
    data: {
      id,
      tenantId,
      purpose: 'community_attachment',
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
