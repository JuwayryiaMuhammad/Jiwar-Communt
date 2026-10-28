import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PermitInspection } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { Notifier } from '../../core/notifications/notifier';
import { drawCertificate } from '../../core/pdf/certificate';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { PermitCore, permitReference } from './permit-core';

export const WORKS_CERTIFICATE_CODE = /^[A-Za-z0-9_-]{22}$/;
export const worksCodeHash = (code: string) =>
  createHash('sha256').update(code, 'utf8').digest('hex');
export const worksCertificateNumber = (n: number) =>
  `WC-${String(n).padStart(6, '0')}`;
const MAX_PHOTOS = 5;

export interface InspectionRead {
  id: string;
  permitId: string;
  cycle: number;
  status: 'asked' | 'passed' | 'failed';
  requestedAt: Date;
  decidedAt: Date | null;
  findings: string[];
  certificateNumber: string | null;
  /** The certificate's code, to the requester and the management. */
  verifyCode: string | null;
}

/** A works certificate as the public check shows it: no person. */
export interface PublicWorksCertificate {
  compoundName: string;
  number: string;
  unitCode: string;
  passedAt: Date;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.PERMIT_INSPECTION_NOT_FOUND,
    'Inspection not found',
  );

function read(i: PermitInspection): InspectionRead {
  return {
    id: i.id,
    permitId: i.permitId,
    cycle: i.cycle,
    status: i.status as InspectionRead['status'],
    requestedAt: i.requestedAt,
    decidedAt: i.decidedAt,
    findings: i.findings,
    certificateNumber:
      i.certificateNumber !== null
        ? worksCertificateNumber(i.certificateNumber)
        : null,
    verifyCode: i.verifyCode,
  };
}

/**
 * Works completion (ADR 0063). The requester of an approved works permit
 * asks for the finished works to be inspected; one inspection open per
 * permit, under the permit's unit lock after the caller's account. The
 * management (`permits.manage`) is told, and decides once, with one to
 * five photos: failed, with findings from a closed list — the requester
 * fixes them and asks again, a new cycle — or passed, which issues the
 * completion certificate: a number (`WC-`), a verify code on the row, the
 * template, and a global pointer for the public check. The certificate is
 * drawn on demand from the row (core PdfRenderer, certificate.v2), for the
 * requester and the management; a permit passes once.
 */
@Injectable()
export class PermitInspectionsService {
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly audit: AuditService,
    private readonly core: PermitCore,
    private readonly community: CommunityGatePort,
    private readonly files: FilesService,
    private readonly globalDb: GlobalDbService,
    private readonly notifier: Notifier,
    private readonly pdf: PdfRenderer,
    private readonly settings: TenantSettingsService,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  // --------------------------------------------------------------------------
  // The requester
  // --------------------------------------------------------------------------

  ask(permitId: string): Promise<InspectionRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const permit = await this.myPermit(tx, permitId);
      await this.core.lockUnit(tx, permit.unitId);
      const fresh = await tx.unitPermit.findUniqueOrThrow({
        where: { id: permitId },
      });
      if (fresh.kind !== 'works' || fresh.status !== 'approved')
        throw appError.conflict(
          ErrorCode.PERMIT_INSPECTION_NOT_ALLOWED,
          'Only an approved works permit is inspected',
        );
      const earlier = await tx.permitInspection.findMany({
        where: { permitId },
        select: { status: true, cycle: true },
      });
      if (earlier.some((e) => e.status === 'passed'))
        throw appError.conflict(
          ErrorCode.PERMIT_INSPECTION_NOT_ALLOWED,
          'These works passed already',
        );
      if (earlier.some((e) => e.status === 'asked'))
        throw appError.conflict(
          ErrorCode.PERMIT_INSPECTION_OPEN,
          'An inspection is asked already',
        );
      const now = await dbNow(tx);
      const cycle = Math.max(0, ...earlier.map((e) => e.cycle)) + 1;
      const row = await tx.permitInspection.create({
        data: {
          id: newId(),
          tenantId: this.ctx.txTenantId,
          permitId,
          cycle,
          requestedBy: this.ctx.accountId,
          requestedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'permit_inspection.requested',
        targetId: row.id,
        metadata: { permitId, unitId: fresh.unitId, cycle },
      });
      await this.notifier.notify(
        tx,
        await this.core.holding(tx, 'permits.manage'),
        {
          kind: 'permit_inspection.requested',
          params: { cycle },
          targetId: row.id,
        },
      );
      return read(row);
    });
  }

  /** The permit's inspections, for its requester. */
  mine(permitId: string): Promise<InspectionRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.myPermit(tx, permitId);
      const rows = await tx.permitInspection.findMany({
        where: { permitId },
        orderBy: { cycle: 'desc' },
      });
      return rows.map(read);
    });
  }

  /** The completion certificate, for the permit's requester. */
  certificate(permitId: string) {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.myPermit(tx, permitId);
      const passed = await tx.permitInspection.findFirst({
        where: { permitId, status: 'passed' },
      });
      if (!passed) throw notFound();
      return this.render(tx, passed);
    });
  }

  // --------------------------------------------------------------------------
  // The management (`permits.manage`)
  // --------------------------------------------------------------------------

  queue(status?: string) {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.permitInspection.findMany({
        where: { status: status ?? 'asked' },
        orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
        take: 200,
      });
      const permits = await tx.unitPermit.findMany({
        where: { id: { in: rows.map((r) => r.permitId) } },
        select: { id: true, number: true, kind: true, unitId: true },
      });
      const codes = await this.community.unitCodes(
        tx,
        permits.map((p) => p.unitId),
      );
      return rows.map((r) => {
        const p = permits.find((x) => x.id === r.permitId)!;
        return {
          ...read(r),
          permitReference: permitReference(p.kind, p.number),
          unitId: p.unitId,
          unitCode: codes.get(p.unitId) ?? '',
        };
      });
    });
  }

  decide(
    id: string,
    input: { outcome: string; findings?: string[]; photoFileIds: string[] },
  ): Promise<InspectionRead> {
    const findings = [...new Set(input.findings ?? [])];
    const allowed: readonly string[] = REASON_CODES.worksFinding;
    const fields: { field: string; code: string; params?: object }[] = [];
    if (input.outcome === 'failed' && !findings.length)
      fields.push({ field: 'findings', code: FieldErrorCode.FIELD_REQUIRED });
    if (input.outcome === 'passed' && findings.length)
      fields.push({
        field: 'findings',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (findings.some((f) => !allowed.includes(f)))
      fields.push({
        field: 'findings',
        code: FieldErrorCode.INVALID_VALUE,
        params: { allowed: [...allowed] },
      });
    if (fields.length)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid', {
        fields: fields as never,
      });
    return this.tenantTx.withTenantTx(async (tx) => {
      const found = await tx.permitInspection.findUnique({ where: { id } });
      if (!found) throw notFound();
      const permit = await tx.unitPermit.findUniqueOrThrow({
        where: { id: found.permitId },
        select: { unitId: true, requestedById: true },
      });
      await this.core.lockUnit(tx, permit.unitId);
      await tx.$queryRaw`
        SELECT id FROM permit_inspections WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await tx.permitInspection.findUniqueOrThrow({
        where: { id },
      });
      if (row.status !== 'asked')
        throw appError.conflict(
          ErrorCode.PERMIT_INSPECTION_DECIDED,
          'Decided already',
        );
      const now = await dbNow(tx);
      for (const fileId of input.photoFileIds.slice(0, MAX_PHOTOS)) {
        const file = await this.files.claim(
          tx,
          fileId,
          'works_inspection_photo',
        );
        if (!file)
          throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
        await this.files.attach(tx, file);
        await tx.permitInspectionPhoto.create({
          data: {
            id: newId(),
            tenantId: row.tenantId,
            inspectionId: id,
            fileId,
            createdAt: now,
          },
        });
      }
      let certificate: { number: number; verifyCode: string } | null = null;
      if (input.outcome === 'passed') {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext(${`works-certificate:${this.ctx.txTenantId}`}), 0)`;
        const last = await tx.permitInspection.findFirst({
          where: { certificateNumber: { not: null } },
          orderBy: { certificateNumber: 'desc' },
          select: { certificateNumber: true },
        });
        certificate = {
          number: (last?.certificateNumber ?? 0) + 1,
          verifyCode: randomBytes(16).toString('base64url'),
        };
      }
      const after = await tx.permitInspection.update({
        where: { id },
        data: {
          status: input.outcome,
          decidedAt: now,
          decidedBy: this.ctx.accountId,
          findings,
          ...(certificate
            ? {
                certificateNumber: certificate.number,
                verifyCode: certificate.verifyCode,
                template: 'certificate.v2',
              }
            : {}),
        },
      });
      if (certificate)
        await this.globalDb.in(tx).worksCertificateLink.create({
          data: {
            codeHash: worksCodeHash(certificate.verifyCode),
            tenantId: row.tenantId,
            inspectionId: id,
            createdAt: now,
          },
        });
      await this.audit.record(tx, {
        action:
          input.outcome === 'passed'
            ? 'permit_inspection.passed'
            : 'permit_inspection.failed',
        targetId: id,
        metadata: {
          permitId: row.permitId,
          cycle: row.cycle,
          photos: Math.min(input.photoFileIds.length, MAX_PHOTOS),
          ...(certificate
            ? { certificateNumber: worksCertificateNumber(certificate.number) }
            : { findings }),
        },
      });
      await this.notifier.notify(tx, [row.requestedBy], {
        kind: 'permit_inspection.decided',
        params: { outcome: input.outcome },
        targetId: id,
      });
      return read(after);
    });
  }

  staffCertificate(id: string) {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.permitInspection.findUnique({ where: { id } });
      if (!row || row.status !== 'passed') throw notFound();
      return this.render(tx, row);
    });
  }

  // --------------------------------------------------------------------------

  /** A permit the caller asked for, else the one not-found. */
  private async myPermit(tx: TenantTxClient, permitId: string) {
    const permit = await tx.unitPermit.findFirst({
      where: { id: permitId, requestedById: this.ctx.accountId },
      select: { id: true, unitId: true },
    });
    if (!permit)
      throw appError.notFound(ErrorCode.PERMIT_NOT_FOUND, 'Permit not found');
    return permit;
  }

  private async render(tx: TenantTxClient, row: PermitInspection) {
    const permit = await tx.unitPermit.findUniqueOrThrow({
      where: { id: row.permitId },
      select: { kind: true, number: true, unitId: true },
    });
    const unitCode = await this.community.unitCode(tx, permit.unitId);
    const { name: compound } = await this.globalDb
      .in(tx)
      .tenant.findUniqueOrThrow({
        where: { id: row.tenantId },
        select: { name: true },
      });
    const { timezone } = await this.settings.inTx(tx, row.tenantId);
    const passedAt = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(row.decidedAt!);
    const number = worksCertificateNumber(row.certificateNumber!);
    const body = await this.pdf.render(
      { title: number, createdAt: row.decidedAt! },
      (page) =>
        drawCertificate(page, {
          template: 'certificate.v2',
          compound,
          titleEn: 'Works completion certificate',
          titleAr: 'شهادة إتمام أعمال',
          number,
          rows: [
            { labelEn: 'Unit', labelAr: 'الوحدة', value: unitCode },
            {
              labelEn: 'Permit',
              labelAr: 'التصريح',
              value: permitReference(permit.kind, permit.number),
            },
            {
              labelEn: 'Inspected',
              labelAr: 'تاريخ المعاينة',
              value: passedAt,
            },
          ],
          statementEn: `The management states that the works in unit ${unitCode} were inspected and found complete.`,
          statementAr: `تشهد الإدارة بأن الأعمال في الوحدة ${unitCode} عوينت ووُجدت مكتملة.`,
          verifyUrl: `${this.appUrl}/w`,
          verifyCode: row.verifyCode!,
        }),
    );
    return { name: `${number}.pdf`, body };
  }
}
