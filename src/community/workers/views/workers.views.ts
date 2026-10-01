import { ApiProperty } from '@nestjs/swagger';
import {
  IdDocumentType,
  WorkerCapacity,
  WorkerEngagementStatus,
} from '@prisma/client';
import {
  AccountRefView,
  accountRef,
  maskDocument,
} from '../../../core/common/http/personal';
import { WorkerScheduleDto } from '../dto/workers.dto';
import type { WorkerSchedule } from '../schedule';
import type {
  CardIncidentView,
  ComplianceCaseView,
  EngagementDetail,
  EngagementView,
  IssuedCode,
  Registered,
  ReviewEngagement,
  WorkerCard,
} from '../workers.service';

const schedule = (s: WorkerSchedule): WorkerScheduleDto => ({
  days: [...s.days],
  windows: s.windows.map((w) => ({ from: w.from, to: w.to })),
});

/** What residents see: their unit's engagements, the worker by name only. */
export class EngagementResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  workerName: string;
  @ApiProperty({ enum: WorkerCapacity, enumName: 'WorkerCapacity' })
  capacity: WorkerCapacity;
  @ApiProperty({ type: WorkerScheduleDto })
  schedule: WorkerScheduleDto;
  @ApiProperty({
    enum: WorkerEngagementStatus,
    enumName: 'WorkerEngagementStatus',
  })
  status: WorkerEngagementStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validUntil: Date | null;
  @ApiProperty({ type: Boolean })
  suspendedByManagement: boolean;

  static from(e: EngagementView): EngagementResponse {
    return {
      id: e.id,
      workerName: e.workerName,
      capacity: e.capacity,
      schedule: schedule(e.schedule),
      status: e.status,
      validUntil: e.validUntil,
      suspendedByManagement: e.suspendedByManagement,
    };
  }
}

export class WarningView {
  @ApiProperty({ enum: ['WORKER_SCHEDULE_CONFLICT'] })
  code: string;
}

/** Warnings never say which unit, how many, or anything about the other engagement. */
export class RegisteredView {
  @ApiProperty({ type: String, format: 'uuid' })
  engagementId: string;
  @ApiProperty({
    enum: WorkerEngagementStatus,
    enumName: 'WorkerEngagementStatus',
  })
  status: WorkerEngagementStatus;
  @ApiProperty({ type: [WarningView] })
  warnings: WarningView[];

  static from(r: Registered): RegisteredView {
    return {
      engagementId: r.engagementId,
      status: r.status,
      warnings: r.warnings.map((w) => ({ code: w.code })),
    };
  }
}

/** An access code, shown once (no-store); null when none was issued. */
/**
 * The printed card's data (ADR 0030), issued once with a new code; there
 * is no GET for it. Labels are the client's, in `preferredLanguage`.
 */
export class WorkerCardView {
  @ApiProperty({ type: String, example: 'JWR1.q3Jz…' })
  qrPayload: string;
  @ApiProperty({ type: String, description: '8 digits.' })
  code: string;
  @ApiProperty({ type: String })
  workerName: string;
  @ApiProperty({ enum: WorkerCapacity, enumName: 'WorkerCapacity' })
  capacity: WorkerCapacity;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  compoundName: string;
  @ApiProperty({ type: WorkerScheduleDto })
  schedule: WorkerScheduleDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validUntil: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: "The compound's emergency phone (E.164), when set.",
  })
  securityPhone: string | null;
  @ApiProperty({ type: String, example: 'ar' })
  preferredLanguage: string;

  static from(c: WorkerCard): WorkerCardView {
    return {
      qrPayload: c.qrPayload,
      code: c.code,
      workerName: c.workerName,
      capacity: c.capacity,
      unitCode: c.unitCode,
      compoundName: c.compoundName,
      schedule: schedule(c.schedule),
      validUntil: c.validUntil,
      securityPhone: c.securityPhone,
      preferredLanguage: c.preferredLanguage,
    };
  }
}

export class AccessCodeView {
  @ApiProperty({ type: String, format: 'uuid' })
  engagementId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '8 digits, shown once.',
  })
  accessCode: string | null;
  @ApiProperty({
    type: WorkerCardView,
    nullable: true,
    description: 'With every new code, once; null when no code was issued.',
  })
  card: WorkerCardView | null;

  static from(engagementId: string, issued: IssuedCode | null): AccessCodeView {
    return {
      engagementId,
      accessCode: issued?.accessCode ?? null,
      card: issued ? WorkerCardView.from(issued.card) : null,
    };
  }
}

export class ReviewEngagementView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid' })
  workerId: string;
  @ApiProperty({ type: String })
  workerName: string;
  @ApiProperty({ enum: WorkerCapacity, enumName: 'WorkerCapacity' })
  capacity: WorkerCapacity;
  @ApiProperty({
    enum: WorkerEngagementStatus,
    enumName: 'WorkerEngagementStatus',
  })
  status: WorkerEngagementStatus;
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  idDocumentType: IdDocumentType;
  @ApiProperty({
    type: Boolean,
    description: 'Passport workers: the birth date was attested.',
  })
  birthDateVerified: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(e: ReviewEngagement): ReviewEngagementView {
    return {
      id: e.id,
      unitId: e.unitId,
      unitCode: e.unitCode,
      workerId: e.workerId,
      workerName: e.workerName,
      capacity: e.capacity,
      status: e.status,
      idDocumentType: e.idDocumentType,
      birthDateVerified: e.birthDateVerified,
      createdAt: e.createdAt,
    };
  }
}

export class ReviewWorkerView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  fullName: string;
  @ApiProperty({ type: String })
  phone: string;
  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  idDocumentType: IdDocumentType;
  @ApiProperty({ type: String, example: '••••1234' })
  idDocumentNumberMasked: string;
  @ApiProperty({ type: String })
  nationality: string;
  @ApiProperty({ type: String, format: 'date' })
  birthDate: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  birthDateVerifiedAt: Date | null;
  @ApiProperty({ type: Boolean })
  banned: boolean;
}

/** One engagement for the manager's review: the document masked. */
export class EngagementDetailView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: WorkerCapacity, enumName: 'WorkerCapacity' })
  capacity: WorkerCapacity;
  @ApiProperty({ type: WorkerScheduleDto })
  schedule: WorkerScheduleDto;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validUntil: Date | null;
  @ApiProperty({
    enum: WorkerEngagementStatus,
    enumName: 'WorkerEngagementStatus',
  })
  status: WorkerEngagementStatus;
  @ApiProperty({ type: AccountRefView })
  requestedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: ReviewWorkerView })
  worker: ReviewWorkerView;

  static from(e: EngagementDetail): EngagementDetailView {
    return {
      id: e.id,
      unitId: e.unitId,
      unitCode: e.unitCode,
      capacity: e.capacity,
      schedule: schedule(e.schedule),
      validUntil: e.validUntil,
      status: e.status,
      requestedBy: accountRef(e.requestedBy),
      createdAt: e.createdAt,
      worker: {
        id: e.worker.id,
        fullName: e.worker.fullName,
        phone: e.worker.phone,
        idDocumentType: e.worker.idDocumentType,
        idDocumentNumberMasked: maskDocument(e.worker.idDocumentNumber)!,
        nationality: e.worker.nationality,
        birthDate: e.worker.birthDate,
        birthDateVerifiedAt: e.worker.birthDateVerifiedAt,
        banned: e.worker.banned,
      },
    };
  }
}

export class CaseCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  caseId: string;
}

export class ComplianceCaseResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  workerId: string;
  @ApiProperty({ enum: ['underage'] })
  kind: 'underage';
  @ApiProperty({ enum: ['open', 'closed'] })
  status: 'open' | 'closed';
  @ApiProperty({ enum: ['review', 'birth_date_correction', 'report'] })
  source: 'review' | 'birth_date_correction' | 'report';
  @ApiProperty({ type: String, format: 'date-time' })
  openedAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;

  static from(c: ComplianceCaseView): ComplianceCaseResponse {
    return {
      id: c.id,
      workerId: c.workerId,
      kind: c.kind,
      status: c.status,
      source: c.source,
      openedAt: c.openedAt,
      closedAt: c.closedAt,
    };
  }
}

/** A card incident in the list: never its note (PII decision, ADR 0025). */
export class CardIncidentResponse {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  engagementId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  workerId: string;
  @ApiProperty({ enum: ['lost', 'confiscated'] })
  type: 'lost' | 'confiscated';
  @ApiProperty({ enum: ['manager', 'resident'] })
  reportedVia: 'manager' | 'resident';
  @ApiProperty({ type: String, format: 'date-time' })
  reportedAt: Date;
  @ApiProperty({ enum: ['open', 'closed'] })
  status: 'open' | 'closed';

  static from(i: CardIncidentView): CardIncidentResponse {
    return {
      id: i.id,
      engagementId: i.engagementId,
      workerId: i.workerId,
      type: i.type,
      reportedVia: i.reportedVia,
      reportedAt: i.reportedAt,
      status: i.status,
    };
  }
}

/** The replacement code, shown once (no-store). */
export class CardIncidentCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  incidentId: string;
  @ApiProperty({ type: String, format: 'uuid' })
  engagementId: string;
  @ApiProperty({ type: String, description: '8 digits, shown once.' })
  accessCode: string;
  @ApiProperty({ type: WorkerCardView, description: 'Shown once.' })
  card: WorkerCardView;
}
