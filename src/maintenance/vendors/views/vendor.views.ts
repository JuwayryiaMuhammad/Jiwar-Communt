import { ApiProperty } from '@nestjs/swagger';
import type { Vendor, VendorEvaluation } from '@prisma/client';
import { ofDateColumn } from '../../schedules/local-dates';
import {
  VENDOR_CATEGORIES,
  VENDOR_DOCUMENT_KINDS,
  VENDOR_STATUSES,
  vendorReference,
} from '../vendor-rules';
import type { VendorDocumentRead, VendorRead } from '../vendors.service';

/** A vendor as the register lists it (ADR 0077). */
export class VendorSummaryView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'V-0001.' })
  reference: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({
    enum: VENDOR_CATEGORIES,
    enumName: 'VendorCategory',
    isArray: true,
  })
  categories: string[];
  @ApiProperty({ enum: VENDOR_STATUSES, enumName: 'VendorStatus' })
  status: string;
  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  partnerId: string | null;

  static from(v: Vendor): VendorSummaryView {
    return {
      id: v.id,
      reference: vendorReference(v.number),
      name: v.name,
      categories: v.categories,
      status: v.status,
      phone: v.phone,
      partnerId: v.partnerId,
    };
  }
}

export class VendorDocumentView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: VENDOR_DOCUMENT_KINDS, enumName: 'VendorDocumentKind' })
  kind: string;
  @ApiProperty({ type: String, nullable: true })
  number: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  issuedOn: string | null;
  @ApiProperty({ type: String, format: 'date', nullable: true })
  expiresOn: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Its expiry passed on the compound’s today.',
  })
  expired: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  addedAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A short-lived link to read the file; null when it is gone.',
  })
  fileUrl: string | null;

  static from(r: VendorDocumentRead): VendorDocumentView {
    const d = r.document;
    return {
      id: d.id,
      kind: d.kind,
      number: d.number,
      issuedOn: d.issuedOn ? ofDateColumn(d.issuedOn) : null,
      expiresOn: d.expiresOn ? ofDateColumn(d.expiresOn) : null,
      expired: r.expired,
      addedAt: d.addedAt,
      fileUrl: r.read?.url ?? null,
    };
  }
}

export class VendorScoresView {
  @ApiProperty({ type: Number, nullable: true })
  quality: number | null;
  @ApiProperty({ type: Number, nullable: true })
  timeliness: number | null;
  @ApiProperty({ type: Number, nullable: true })
  cost: number | null;
  @ApiProperty({ type: Number, nullable: true })
  communication: number | null;
  @ApiProperty({ type: Number, nullable: true })
  safety: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The mean of each evaluation’s mean.',
  })
  overall: number | null;
}

export class VendorEvaluationsSummaryView {
  @ApiProperty({ type: Number, description: 'In the last year.' })
  count: number;
  @ApiProperty({ type: VendorScoresView })
  averages: VendorScoresView;
}

export class VendorContractsSummaryView {
  @ApiProperty({ type: Number })
  total: number;
  @ApiProperty({
    type: Number,
    description: 'In force on the compound’s today.',
  })
  active: number;
}

/** A vendor with its papers, its last year's evaluations and its contracts. */
export class VendorView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'V-0001.' })
  reference: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({
    enum: VENDOR_CATEGORIES,
    enumName: 'VendorCategory',
    isArray: true,
  })
  categories: string[];
  @ApiProperty({ enum: VENDOR_STATUSES, enumName: 'VendorStatus' })
  status: string;
  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  partnerId: string | null;
  @ApiProperty({ type: String, nullable: true })
  legalName: string | null;
  @ApiProperty({ type: String, nullable: true })
  commercialRegister: string | null;
  @ApiProperty({ type: String, nullable: true })
  taxNumber: string | null;
  @ApiProperty({ type: String, nullable: true })
  contactName: string | null;
  @ApiProperty({ type: String, nullable: true })
  email: string | null;
  @ApiProperty({ type: String, nullable: true })
  address: string | null;
  @ApiProperty({ type: String, nullable: true })
  notes: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  suspendedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'REASON_CODES.vendorSuspend.',
  })
  suspendReason: string | null;
  @ApiProperty({
    type: [VendorDocumentView],
    description: 'The live papers, newest first.',
  })
  documents: VendorDocumentView[];
  @ApiProperty({ type: Boolean, description: 'A live paper’s expiry passed.' })
  documentsExpired: boolean;
  @ApiProperty({ type: VendorEvaluationsSummaryView })
  evaluations: VendorEvaluationsSummaryView;
  @ApiProperty({ type: VendorContractsSummaryView })
  contracts: VendorContractsSummaryView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: VendorRead): VendorView {
    const v = r.vendor;
    return {
      ...VendorSummaryView.from(v),
      legalName: v.legalName,
      commercialRegister: v.commercialRegister,
      taxNumber: v.taxNumber,
      contactName: v.contactName,
      email: v.email,
      address: v.address,
      notes: v.notes,
      suspendedAt: v.suspendedAt,
      suspendReason: v.suspendReason,
      documents: r.documents.map((d) => VendorDocumentView.from(d)),
      documentsExpired: r.documentsExpired,
      evaluations: r.evaluations,
      contracts: r.contracts,
      createdAt: v.createdAt,
    };
  }
}

export class VendorEvaluationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  contractId: string | null;
  @ApiProperty({ type: Number })
  quality: number;
  @ApiProperty({ type: Number })
  timeliness: number;
  @ApiProperty({ type: Number })
  cost: number;
  @ApiProperty({ type: Number })
  communication: number;
  @ApiProperty({ type: Number })
  safety: number;
  @ApiProperty({ type: String, nullable: true })
  note: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  evaluatedById: string;
  @ApiProperty({ type: String, format: 'date-time' })
  evaluatedAt: Date;

  static from(e: VendorEvaluation): VendorEvaluationView {
    return {
      id: e.id,
      contractId: e.contractId,
      quality: e.quality,
      timeliness: e.timeliness,
      cost: e.cost,
      communication: e.communication,
      safety: e.safety,
      note: e.note,
      evaluatedById: e.evaluatedById,
      evaluatedAt: e.evaluatedAt,
    };
  }
}
