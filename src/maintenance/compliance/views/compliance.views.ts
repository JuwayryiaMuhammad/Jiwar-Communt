import { ApiProperty } from '@nestjs/swagger';
import type { ComplianceOccurrence } from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { ofDateColumn, ofDateColumnOrNull } from '../../schedules/local-dates';
import {
  COMPLIANCE_KINDS,
  COMPLIANCE_STATES,
  OCCURRENCE_STATUSES,
} from '../compliance-rules';
import type {
  CalendarEntry,
  ComplianceItemDetail,
  ComplianceItemRead,
  ComplianceReport,
  OccurrenceRead,
  StatusCounts,
} from '../compliance.service';

export class ComplianceVendorView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ enum: ['active', 'suspended'], enumName: 'VendorStatus' })
  status: string;
}

export class ComplianceSubjectView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String })
  nameAr: string;
}

export class ComplianceEvidenceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived link to read the file; null when it is gone.',
  })
  fileUrl: string | null;
}

/** A due day of a compliance item (ADR 0087). */
export class ComplianceOccurrenceView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date' })
  dueOn: string;
  @ApiProperty({
    enum: OCCURRENCE_STATUSES,
    enumName: 'ComplianceOccurrenceStatus',
  })
  status: string;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  doneOn: string | null;
  @ApiProperty({ type: String, nullable: true })
  certificateNumber: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  expiresOn: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'About the work.' })
  note: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  previousId: string | null;

  static from(o: ComplianceOccurrence): ComplianceOccurrenceView {
    return {
      id: o.id,
      dueOn: ofDateColumn(o.dueOn),
      status: o.status,
      doneOn: ofDateColumnOrNull(o.doneOn),
      certificateNumber: o.certificateNumber,
      expiresOn: ofDateColumnOrNull(o.expiresOn),
      note: o.note,
      previousId: o.previousId,
    };
  }
}

export class ComplianceArchiveView extends ComplianceOccurrenceView {
  @ApiProperty({ type: [ComplianceEvidenceView] })
  evidence: ComplianceEvidenceView[];

  static fromRead(r: OccurrenceRead): ComplianceArchiveView {
    return {
      ...ComplianceOccurrenceView.from(r.occurrence),
      evidence: r.evidence.map((e) => ({
        id: e.evidence.id,
        addedAt: e.evidence.addedAt,
        fileUrl: e.read?.url ?? null,
      })),
    };
  }
}

/** A compliance item as the calendar's keepers list it (ADR 0087). */
export class ComplianceItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: COMPLIANCE_KINDS, enumName: 'ComplianceKind' })
  kind: string;
  @ApiProperty({ type: String })
  title: string;
  @ApiProperty({ type: String, nullable: true })
  authority: string | null;
  @ApiProperty({ type: String, nullable: true })
  reference: string | null;
  @ApiProperty({ type: ComplianceSubjectView, nullable: true })
  asset: ComplianceSubjectView | null;
  @ApiProperty({ type: ComplianceSubjectView, nullable: true })
  commonArea: ComplianceSubjectView | null;
  @ApiProperty({ type: ComplianceVendorView, nullable: true })
  vendor: ComplianceVendorView | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  owner: AccountRefView | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Null: once.' })
  recurrenceMonths: number | null;
  @ApiProperty({
    type: [Number],
    description: 'The lead times in force, longest first.',
  })
  leadDays: number[];
  @ApiProperty({
    type: Boolean,
    description: 'Its own lead times, not the compound’s.',
  })
  ownLeadDays: boolean;
  @ApiProperty({ type: String, nullable: true })
  notes: string | null;
  @ApiProperty({
    enum: COMPLIANCE_STATES,
    enumName: 'ComplianceState',
    description: 'On the compound’s today.',
  })
  state: string;
  @ApiProperty({ type: ComplianceOccurrenceView, nullable: true })
  current: ComplianceOccurrenceView | null;
  @ApiProperty({ type: ComplianceOccurrenceView, nullable: true })
  lastDone: ComplianceOccurrenceView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  retiredAt: Date | null;
  @ApiProperty({
    enum: REASON_CODES.complianceRetire,
    enumName: 'ComplianceRetireReason',
    nullable: true,
  })
  retireReason: string | null;

  static from(r: ComplianceItemRead): ComplianceItemView {
    const i = r.item;
    return {
      id: i.id,
      kind: i.kind,
      title: i.title,
      authority: i.authority,
      reference: i.reference,
      asset: r.asset && { ...r.asset },
      commonArea: r.commonArea && { ...r.commonArea },
      vendor: r.vendor && { ...r.vendor },
      owner: r.owner ? accountRef(r.owner) : null,
      recurrenceMonths: i.recurrenceMonths,
      leadDays: r.leadDays,
      ownLeadDays: i.leadDays.length > 0,
      notes: i.notes,
      state: r.state,
      current: r.current ? ComplianceOccurrenceView.from(r.current) : null,
      lastDone: r.lastDone ? ComplianceOccurrenceView.from(r.lastDone) : null,
      retiredAt: i.retiredAt,
      retireReason: i.retireReason,
    };
  }
}

export class ComplianceItemDetailView extends ComplianceItemView {
  @ApiProperty({
    type: [ComplianceArchiveView],
    description:
      'Its due days, the latest first (100 at most), with their evidence.',
  })
  occurrences: ComplianceArchiveView[];

  static fromDetail(d: ComplianceItemDetail): ComplianceItemDetailView {
    return {
      ...ComplianceItemView.from(d),
      occurrences: d.occurrences.map((o) => ComplianceArchiveView.fromRead(o)),
    };
  }
}

export class ComplianceCalendarEntryView {
  @ApiProperty({
    enum: ['compliance', 'vendor_document'],
    description:
      '`compliance`: an item’s due day; `vendor_document`: a vendor’s paper expiring (ADR 0077).',
  })
  source: string;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date' })
  day: string;
  @ApiProperty({
    type: String,
    description: 'ComplianceKind, or the paper’s VendorDocumentKind.',
  })
  kind: string;
  @ApiProperty({
    enum: ['valid', 'due_soon', 'overdue', 'done', 'expired'],
    enumName: 'ComplianceCalendarState',
  })
  state: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  itemId: string | null;
  @ApiProperty({ type: String, nullable: true })
  title: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  vendorId: string | null;
  @ApiProperty({ type: String, nullable: true })
  vendorName: string | null;

  static from(e: CalendarEntry): ComplianceCalendarEntryView {
    return { ...e };
  }
}

export class ComplianceCalendarView {
  @ApiProperty({ type: String, format: 'date' })
  from: string;
  @ApiProperty({ type: String, format: 'date' })
  to: string;
  @ApiProperty({ type: [ComplianceCalendarEntryView] })
  entries: ComplianceCalendarEntryView[];
  @ApiProperty({
    type: Boolean,
    description: 'More than 1000 entries: ask for fewer days.',
  })
  truncated: boolean;
}

export class ComplianceStatusCountsView {
  @ApiProperty({ type: Number, description: 'Not retired.' })
  items: number;
  @ApiProperty({ type: Number })
  valid: number;
  @ApiProperty({ type: Number })
  dueSoon: number;
  @ApiProperty({ type: Number })
  overdue: number;
  @ApiProperty({ type: Number, description: 'Done once; nothing recurs.' })
  completed: number;
  @ApiProperty({ type: Number })
  retired: number;
}

export class ComplianceKindCountsView extends ComplianceStatusCountsView {
  @ApiProperty({ enum: COMPLIANCE_KINDS, enumName: 'ComplianceKind' })
  kind: string;
}

export class VendorPapersCountsView {
  @ApiProperty({ type: Number })
  valid: number;
  @ApiProperty({ type: Number, description: 'Within 30 days.' })
  expiringSoon: number;
  @ApiProperty({ type: Number })
  expired: number;
}

/** Where the compound's obligations stand today (ADR 0087): counts only. */
export class ComplianceReportView {
  @ApiProperty({ type: String, format: 'date' })
  asOf: string;
  @ApiProperty({ type: ComplianceStatusCountsView })
  totals: ComplianceStatusCountsView;
  @ApiProperty({
    type: [ComplianceKindCountsView],
    description: 'Every kind, in a fixed order, with zeros.',
  })
  kinds: ComplianceKindCountsView[];
  @ApiProperty({ type: VendorPapersCountsView })
  vendorPapers: VendorPapersCountsView;

  static from(r: ComplianceReport): ComplianceReportView {
    const c = (x: StatusCounts) => ({ ...x });
    return {
      asOf: r.asOf,
      totals: c(r.totals),
      kinds: r.kinds.map((k) => ({ ...c(k), kind: k.kind })),
      vendorPapers: { ...r.vendorPapers },
    };
  }
}

export class ComplianceSettingsView {
  @ApiProperty({ type: [Number], description: 'Longest first.' })
  leadDays: number[];
}
