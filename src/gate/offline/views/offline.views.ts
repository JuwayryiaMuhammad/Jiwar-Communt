import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import type { FlagView } from '../offline-flags.service';
import { FLAG_KINDS, REJECTIONS, type FlagKind } from '../offline-rules';
import type {
  ActionResult,
  BatchView,
  UploadResult,
} from '../offline-uploads.service';

const STATUSES = ['recorded', 'duplicate', 'rejected', 'quarantined'] as const;

export class OfflineActionResultView {
  @ApiProperty({ type: String, format: 'uuid' })
  clientId: string;
  @ApiProperty({ type: Number })
  seq: number;
  @ApiProperty({
    enum: STATUSES,
    enumName: 'OfflineActionStatus',
    description:
      '`recorded` now; `duplicate`: recorded before (a retry); `rejected`: it cannot have happened as said (its `reason`), or another action holds its id or sequence number; `quarantined`: the device was revoked, the management decides.',
  })
  status: (typeof STATUSES)[number];
  @ApiProperty({
    enum: [...REJECTIONS, 'client_id_reused', 'sequence_reused'],
    nullable: true,
  })
  reason: string | null;
  @ApiProperty({ enum: FLAG_KINDS, enumName: 'OfflineFlagKind', isArray: true })
  flags: FlagKind[];
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  entryId: string | null;

  static from(r: ActionResult): OfflineActionResultView {
    return { ...r };
  }
}

/** What the device learns of its batch (ADR 0057): its confirmation. */
export class OfflineUploadResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  batchId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({
    type: Number,
    description:
      'Every action of the device up to this sequence number was received: it may forget them.',
  })
  ackedThroughSeq: number;
  @ApiProperty({ type: [OfflineActionResultView] })
  results: OfflineActionResultView[];
  @ApiProperty({ type: String, format: 'date-time' })
  serverTime: Date;

  static from(r: UploadResult): OfflineUploadResponse {
    return {
      ...r,
      results: r.results.map((x) => OfflineActionResultView.from(x)),
    };
  }
}

export class FlagSubjectView {
  @ApiProperty({ type: String })
  type: string;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
}

/** An offline flag as the management reads it (ADR 0057): codes only. */
export class OfflineFlagResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: FLAG_KINDS, enumName: 'OfflineFlagKind' })
  kind: FlagKind;
  @ApiProperty({ enum: ['security', 'manager', 'info'] })
  class: 'security' | 'manager' | 'info';
  @ApiProperty({ enum: ['open', 'cleared', 'reviewed'] })
  status: 'open' | 'cleared' | 'reviewed';
  @ApiProperty({ type: String, format: 'uuid' })
  batchId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actionId: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  deviceId: string;
  @ApiProperty({ type: FlagSubjectView, nullable: true })
  subject: FlagSubjectView | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  gateId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  shiftId: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Codes and numbers: a refusal’s `reason`, a clock’s `skewSeconds` or `offsetSeconds`, a rejected action’s `reason` and `seq`.',
  })
  params: Record<string, unknown>;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the action it is about happened, by its device.',
  })
  occurredAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  clearedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt: Date | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  reviewedBy: AccountRefView | null;
  @ApiProperty({ enum: [...REASON_CODES.offlineFlagReview], nullable: true })
  reviewCode: string | null;

  static from(v: FlagView): OfflineFlagResponse {
    return {
      ...v,
      reviewedBy: v.reviewedBy ? accountRef(v.reviewedBy) : null,
    };
  }
}

export class OfflineBatchActionView {
  @ApiProperty({ type: String, format: 'uuid' })
  clientId: string;
  @ApiProperty({ type: Number })
  seq: number;
  @ApiProperty({ type: String })
  type: string;
  @ApiProperty({ enum: ['recorded', 'rejected', 'quarantined'] })
  status: 'recorded' | 'rejected' | 'quarantined';
  @ApiProperty({ enum: [...REJECTIONS], nullable: true })
  reason: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  deviceTime: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  occurredAt: Date | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  entryId: string | null;
  @ApiProperty({
    type: FlagSubjectView,
    nullable: true,
    description: 'What a quarantined action says it was about.',
  })
  subject: FlagSubjectView | null;
  @ApiProperty({ type: String, nullable: true })
  direction: string | null;
}

/** A batch a device uploaded, as the management reads it (ADR 0057). */
export class OfflineBatchResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  deviceId: string;
  @ApiProperty({ type: AccountRefView })
  uploadedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  receivedAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  sentAt: Date;
  @ApiProperty({
    type: Number,
    description: 'The device’s clock less the server’s when it was sent.',
  })
  clockOffsetMs: number;
  @ApiProperty({ type: Number })
  actionCount: number;
  @ApiProperty({
    enum: ['accepted', 'quarantined'],
    description: '`quarantined`: from a device revoked when it arrived.',
  })
  status: 'accepted' | 'quarantined';
  @ApiProperty({ type: Boolean })
  pendingReview: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt: Date | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  reviewedBy: AccountRefView | null;
  @ApiProperty({ enum: ['accepted', 'rejected'], nullable: true })
  reviewDecision: 'accepted' | 'rejected' | null;
  @ApiProperty({ type: [OfflineBatchActionView] })
  actions: OfflineBatchActionView[];

  static from(v: BatchView): OfflineBatchResponse {
    return {
      ...v,
      uploadedBy: accountRef(v.uploadedBy),
      reviewedBy: v.reviewedBy ? accountRef(v.reviewedBy) : null,
    };
  }
}
