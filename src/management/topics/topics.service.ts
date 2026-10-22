import { Injectable } from '@nestjs/common';
import type { ManagementRequestTopic } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { SYSTEM_TOPICS } from '../settings/defaults';

/** The system topics' keys: never offered to residents, never picked by them (ADR 0060). */
export const SYSTEM_TOPIC_KEYS: readonly string[] = SYSTEM_TOPICS.map(
  (t) => t.key,
);

export interface TopicInput {
  key: string;
  nameAr: string;
  nameEn: string;
  targetResponseHours: number;
}

export type TopicUpdate = Partial<
  Pick<
    ManagementRequestTopic,
    'nameAr' | 'nameEn' | 'targetResponseHours' | 'active' | 'ownerRoleId'
  >
>;

/** A topic and the role that owns it, by key and name (ADR 0058). */
export type TopicRead = ManagementRequestTopic & {
  ownerRole: { key: string; name: string | null } | null;
};

const WITH_OWNER = { ownerRole: { select: { key: true, name: true } } };

export const topicNotFound = () =>
  appError.notFound(
    ErrorCode.MANAGEMENT_TOPIC_NOT_FOUND,
    'Management request topic not found',
  );

/**
 * What the audit trail records of a topic: its key, target and state by
 * value, the names as "changed" only (the action marks them sensitive).
 */
function audited(t: ManagementRequestTopic) {
  return {
    key: t.key,
    nameAr: t.nameAr,
    nameEn: t.nameEn,
    targetResponseHours: t.targetResponseHours,
    active: t.active,
    ownerRoleId: t.ownerRoleId,
  };
}

/**
 * The compound's request topics (ADR 0039): its own closed list, managed
 * with `requests.manage`. Never deleted, because requests point at them; a
 * retired topic is `active: false` and no longer offered.
 */
@Injectable()
export class TopicsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every topic, retired ones included (a compound has a handful). */
  list(): Promise<TopicRead[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.managementRequestTopic.findMany({
        orderBy: [{ key: 'asc' }],
        include: WITH_OWNER,
      }),
    );
  }

  /** What a request may be opened under, and who owns each. */
  options(): Promise<TopicRead[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.managementRequestTopic.findMany({
        where: { active: true, key: { notIn: [...SYSTEM_TOPIC_KEYS] } },
        orderBy: [{ key: 'asc' }],
        include: WITH_OWNER,
      }),
    );
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: TopicInput): Promise<TopicRead> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const topic = await tx.managementRequestTopic.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
          targetResponseHours: input.targetResponseHours,
        },
        include: WITH_OWNER,
      });
      await this.audit.record(tx, {
        action: 'management_request_topic.created',
        targetId: topic.id,
        changes: diffChanges(
          null,
          audited(topic),
          'management_request_topic.created',
        ),
      });
      return topic;
    });
  }

  /**
   * The key never changes: apps and reports may hold on to it. A new target
   * applies from the next cycle on; a running cycle keeps its due time.
   */
  update(id: string, input: TopicUpdate): Promise<TopicRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.managementRequestTopic.findUnique({
        where: { id },
      });
      if (!before) throw topicNotFound();
      if (input.ownerRoleId) {
        // A staff role of the compound (RLS), or none.
        const role = await tx.role.findUnique({
          where: { id: input.ownerRoleId },
          select: { kind: true },
        });
        if (!role)
          throw appError.notFound(ErrorCode.ROLE_NOT_FOUND, 'Role not found');
        if (role.kind !== 'staff' && role.kind !== 'manager')
          throw appError.badRequest(
            ErrorCode.VALIDATION_FAILED,
            'The owner is a staff role',
            {
              fields: [
                {
                  field: 'ownerRoleId',
                  code: FieldErrorCode.TOPIC_OWNER_NOT_STAFF,
                },
              ],
            },
          );
      }
      const topic = await tx.managementRequestTopic.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          targetResponseHours: input.targetResponseHours,
          active: input.active,
          ownerRoleId: input.ownerRoleId,
        },
        include: WITH_OWNER,
      });
      const changes = diffChanges(
        audited(before),
        audited(topic),
        'management_request_topic.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'management_request_topic.updated',
          targetId: topic.id,
          changes,
        });
      return topic;
    });
  }
}
