import { Injectable } from '@nestjs/common';
import type { SuggestionTopic } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';

export interface SuggestionTopicInput {
  key: string;
  nameAr: string;
  nameEn: string;
}

export type SuggestionTopicUpdate = Partial<
  Pick<SuggestionTopic, 'nameAr' | 'nameEn' | 'active'>
>;

export const suggestionTopicNotFound = () =>
  appError.notFound(
    ErrorCode.SUGGESTION_TOPIC_NOT_FOUND,
    'Suggestion topic not found',
  );

/**
 * What the audit trail records of a topic: its key and state by value, the
 * names as "changed" only (the action marks them sensitive).
 */
function audited(t: SuggestionTopic) {
  return { key: t.key, nameAr: t.nameAr, nameEn: t.nameEn, active: t.active };
}

/**
 * The compound's suggestion topics (ADR 0040): its own closed list, managed
 * with `community.suggestions`. Never deleted, because suggestions point at
 * them; a retired topic is `active: false` and no longer offered.
 */
@Injectable()
export class SuggestionTopicsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
  ) {}

  /** Every topic, retired ones included (a compound has a handful). */
  list(): Promise<SuggestionTopic[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.suggestionTopic.findMany({ orderBy: [{ key: 'asc' }] }),
    );
  }

  /** What a suggestion may be written under. */
  options(): Promise<SuggestionTopic[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.suggestionTopic.findMany({
        where: { active: true },
        orderBy: [{ key: 'asc' }],
      }),
    );
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: SuggestionTopicInput): Promise<SuggestionTopic> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const topic = await tx.suggestionTopic.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
        },
      });
      await this.audit.record(tx, {
        action: 'suggestion_topic.created',
        targetId: topic.id,
        changes: diffChanges(null, audited(topic), 'suggestion_topic.created'),
      });
      return topic;
    });
  }

  /** The key never changes: apps and reports may hold on to it. */
  update(id: string, input: SuggestionTopicUpdate): Promise<SuggestionTopic> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.suggestionTopic.findUnique({ where: { id } });
      if (!before) throw suggestionTopicNotFound();
      const topic = await tx.suggestionTopic.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(topic),
        'suggestion_topic.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'suggestion_topic.updated',
          targetId: topic.id,
          changes,
        });
      return topic;
    });
  }
}
