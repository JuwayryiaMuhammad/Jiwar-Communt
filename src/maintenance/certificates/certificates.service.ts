import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { StaffCertificate } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { Notifier } from '../../core/notifications/notifier';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  addDays,
  daysBetween,
  dateColumn,
  ofDateColumn,
  ofDateColumnOrNull,
  type LocalDate,
} from '../schedules/local-dates';
import {
  CERTIFICATE_NOTICE_DAYS,
  certificateState,
  noticeDue,
  type CertificateState,
  type StaffCertificateKind,
} from './certificate-rules';

export const CERTIFICATE_SWEEP = 'maintenance.staff_certificates';
/** Certificates expire on a day: an hourly look is soon enough. */
export const CERTIFICATE_SWEEP_INTERVAL_MS = 60 * 60_000;
const SWEEP_BATCH = 200;
const LIST_MAX = 500;

export interface CertificateInput {
  accountId: string;
  kind: StaffCertificateKind;
  title: string;
  issuer?: string;
  reference?: string;
  issuedOn?: LocalDate;
  expiresOn: LocalDate;
  fileId?: string;
}

export interface CertificateUpdate {
  kind?: StaffCertificateKind;
  title?: string;
  issuer?: string | null;
  reference?: string | null;
  issuedOn?: LocalDate | null;
  expiresOn?: LocalDate;
  /** A new paper; null removes the one filed. */
  fileId?: string | null;
}

export interface CertificateRead {
  certificate: StaffCertificate;
  holder: { id: string; fullName: string | null; status: string };
  state: CertificateState;
  daysLeft: number;
  /** Only on a single read: a short-lived link to the paper. */
  read: PresignedRead | null;
}

const notFound = () =>
  appError.notFound(
    ErrorCode.STAFF_CERTIFICATE_NOT_FOUND,
    'Certificate not found',
  );

/**
 * Staff certificates (ADR 0090): a staff member's certificate with the day
 * it expires and its paper, kept by the field team (`field_team.manage`).
 *
 * - **Warn only.** The holder and the field team are told 30 days before
 *   it expires and on the day, once each per expiry; an expired
 *   certificate blocks no assignment and no work.
 * - **The compliance calendar** reads the live ones where they are (ADR
 *   0087), never a copy.
 * - **Locks:** the holder's account FOR SHARE (an erasure holds it FOR
 *   UPDATE first), then the certificate FOR UPDATE; the sweep takes the
 *   certificate alone, and decides by what it reads after the lock.
 * - **Leaving:** a deactivated holder's certificates stay (the record) and
 *   are told no more; an erased one's are deleted with their papers.
 */
@Injectable()
export class CertificatesService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly calendar: CompoundCalendar,
    private readonly sweep: SweepRunner,
    private readonly staff: StaffRecipients,
    private readonly notifier: Notifier,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(CERTIFICATE_SWEEP, () => this.run(), {
      intervalMs: CERTIFICATE_SWEEP_INTERVAL_MS,
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  /** The field team's list, soonest expiry first. */
  list(q: {
    accountId?: string;
    state?: CertificateState;
    removed?: boolean;
  }): Promise<CertificateRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { today } = await this.calendar.now(tx);
      const expiry =
        q.state === 'expired'
          ? { lt: dateColumn(today) }
          : q.state === 'expiring'
            ? {
                gte: dateColumn(today),
                lte: dateColumn(addDays(today, CERTIFICATE_NOTICE_DAYS)),
              }
            : q.state === 'valid'
              ? { gt: dateColumn(addDays(today, CERTIFICATE_NOTICE_DAYS)) }
              : undefined;
      const rows = await tx.staffCertificate.findMany({
        where: {
          ...(q.accountId ? { accountId: q.accountId } : {}),
          ...(q.removed ? { removedAt: { not: null } } : { removedAt: null }),
          ...(expiry ? { expiresOn: expiry } : {}),
        },
        orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
        take: LIST_MAX,
      });
      return this.reads(tx, rows, today, false);
    });
  }

  /** One, with its paper's link. */
  get(id: string): Promise<CertificateRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.staffCertificate.findUnique({ where: { id } });
      if (!row) throw notFound();
      const { today } = await this.calendar.now(tx);
      return (await this.reads(tx, [row], today, true))[0];
    });
  }

  /** A holder's own live certificates, with their papers' links. */
  mine(): Promise<CertificateRead[]> {
    if (this.ctx.accountType !== 'staff')
      throw appError.forbidden(
        ErrorCode.FORBIDDEN,
        'Certificates are the staff’s',
      );
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.staffCertificate.findMany({
        where: { accountId: this.ctx.accountId, removedAt: null },
        orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
        take: LIST_MAX,
      });
      const { today } = await this.calendar.now(tx);
      return this.reads(tx, rows, today, true);
    });
  }

  /** Added for an active staff member, with its paper when filed. */
  create(input: CertificateInput): Promise<CertificateRead> {
    const words = this.words(input);
    if (input.issuedOn && input.issuedOn >= input.expiresOn)
      throw invalid([
        { field: 'expiresOn', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockHolder(tx, input.accountId);
      const fileId = input.fileId
        ? await this.claimFile(tx, input.fileId)
        : null;
      const now = await dbNow(tx);
      const id = newId();
      const row = await tx.staffCertificate.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          accountId: input.accountId,
          kind: input.kind,
          title: words.title!,
          issuer: words.issuer ?? null,
          reference: words.reference ?? null,
          issuedOn: input.issuedOn ? dateColumn(input.issuedOn) : null,
          expiresOn: dateColumn(input.expiresOn),
          fileId,
          addedById: this.ctx.accountId,
          addedAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'staff_certificate.added',
        targetId: id,
        metadata: {
          holderId: input.accountId,
          kind: input.kind,
          expiresOn: input.expiresOn,
          file: fileId !== null,
        },
      });
      const { today } = await this.calendar.now(tx);
      return (await this.reads(tx, [row], today, true))[0];
    });
  }

  /**
   * Changed while live: its words, its days, its paper (replaced or
   * removed). A new expiry is a renewal: its notices start again.
   */
  update(id: string, patch: CertificateUpdate): Promise<CertificateRead> {
    const words = this.words(patch);
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      const issuedOn =
        patch.issuedOn === undefined
          ? ofDateColumnOrNull(before.issuedOn)
          : patch.issuedOn;
      const expiresOn = patch.expiresOn ?? ofDateColumn(before.expiresOn);
      if (issuedOn && issuedOn >= expiresOn)
        throw invalid([
          {
            field: patch.expiresOn ? 'expiresOn' : 'issuedOn',
            code: FieldErrorCode.ENDS_BEFORE_START,
          },
        ]);
      let fileId = before.fileId;
      let file: 'replaced' | 'added' | 'removed' | null = null;
      if (patch.fileId !== undefined && patch.fileId !== before.fileId) {
        if (before.fileId)
          await this.files.markDeleted(
            tx,
            { id: before.fileId, purpose: 'staff_certificate' },
            'replaced',
          );
        fileId = patch.fileId ? await this.claimFile(tx, patch.fileId) : null;
        file = !before.fileId ? 'added' : fileId ? 'replaced' : 'removed';
      }
      const renewed = expiresOn !== ofDateColumn(before.expiresOn);
      const row = await tx.staffCertificate.update({
        where: { id },
        data: {
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(words.title !== undefined ? { title: words.title } : {}),
          ...(words.issuer !== undefined ? { issuer: words.issuer } : {}),
          ...(words.reference !== undefined
            ? { reference: words.reference }
            : {}),
          issuedOn: issuedOn ? dateColumn(issuedOn) : null,
          expiresOn: dateColumn(expiresOn),
          fileId,
          ...(renewed ? { warnedFor: null, dayToldFor: null } : {}),
          updatedAt: await dbNow(tx),
        },
      });
      const changed: Record<string, unknown> = {};
      if (patch.kind !== undefined && patch.kind !== before.kind)
        changed.kind = { from: before.kind, to: patch.kind };
      for (const key of ['title', 'issuer', 'reference'] as const)
        if (words[key] !== undefined && words[key] !== before[key])
          changed[key] = { changed: true };
      if (
        patch.issuedOn !== undefined &&
        issuedOn !== ofDateColumnOrNull(before.issuedOn)
      )
        changed.issuedOn = {
          from: ofDateColumnOrNull(before.issuedOn),
          to: issuedOn,
        };
      if (renewed)
        changed.expiresOn = {
          from: ofDateColumn(before.expiresOn),
          to: expiresOn,
        };
      if (file) changed.file = file;
      if (Object.keys(changed).length)
        await this.audit.record(tx, {
          action: 'staff_certificate.changed',
          targetId: id,
          metadata: changed,
        });
      const { today } = await this.calendar.now(tx);
      return (await this.reads(tx, [row], today, true))[0];
    });
  }

  /** Removed once (filed by mistake, or no longer held): its paper goes. */
  remove(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.fileId)
        await this.files.markDeleted(
          tx,
          { id: before.fileId, purpose: 'staff_certificate' },
          'withdrawn',
        );
      const now = await dbNow(tx);
      await tx.staffCertificate.update({
        where: { id },
        data: {
          removedAt: now,
          removedById: this.ctx.accountId,
          fileId: null,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'staff_certificate.removed',
        targetId: id,
        metadata: { kind: before.kind },
      });
    });
  }

  /**
   * The notices owed today across the compounds: 30 days ahead, and on the
   * day, once per expiry; never for a removed certificate or an inactive
   * holder. Each in a transaction of its own, under its row.
   */
  run(): Promise<number> {
    return this.sweep.forEachTenantItem(
      async (tx, tenantId) => {
        const { today } = await this.calendar.now(tx, tenantId);
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT c.id FROM staff_certificates c
            JOIN accounts a ON a.id = c.account_id AND a.status = 'active'
           WHERE c.removed_at IS NULL
             AND c.expires_on >= ${today}::date
             AND c.expires_on - ${CERTIFICATE_NOTICE_DAYS}::int <= ${today}::date
             AND (c.warned_for IS DISTINCT FROM c.expires_on
                  OR (c.expires_on = ${today}::date
                      AND c.day_told_for IS DISTINCT FROM c.expires_on))
           ORDER BY c.expires_on, c.id
           LIMIT ${SWEEP_BATCH}`;
        return rows.map((r) => r.id);
      },
      (tx, tenantId, id) => this.tell(tx, tenantId, id),
    );
  }

  // --------------------------------------------------------------------------

  private async tell(
    tx: TenantTxClient,
    tenantId: string,
    id: string,
  ): Promise<number> {
    await tx.$queryRaw`SELECT id FROM staff_certificates WHERE id = ${id}::uuid FOR UPDATE`;
    const c = await tx.staffCertificate.findUnique({ where: { id } });
    if (!c || c.removedAt) return 0;
    const holder = await tx.account.findUnique({
      where: { id: c.accountId },
      select: { status: true },
    });
    if (holder?.status !== 'active') return 0;
    const { today } = await this.calendar.now(tx, tenantId);
    const expiresOn = ofDateColumn(c.expiresOn);
    const due = noticeDue(
      {
        expiresOn,
        warnedFor: ofDateColumnOrNull(c.warnedFor),
        dayToldFor: ofDateColumnOrNull(c.dayToldFor),
      },
      today,
    );
    if (!due) return 0;
    await tx.staffCertificate.update({
      where: { id },
      // The day's notice stands for the warning too: never a warning after.
      data:
        due === 'expires_today'
          ? { dayToldFor: c.expiresOn, warnedFor: c.expiresOn }
          : { warnedFor: c.expiresOn },
    });
    const team = (await this.staff.holding(tx, 'field_team.manage')).map(
      (r) => r.id,
    );
    const to = [...new Set([c.accountId, ...team])];
    await this.notifier.notify(
      tx,
      to,
      due === 'expires_today'
        ? {
            kind: 'staff_certificate.expires_today',
            params: { certificateKind: c.kind, expiresOn },
            targetId: id,
          }
        : {
            kind: 'staff_certificate.expiring',
            params: {
              certificateKind: c.kind,
              expiresOn,
              daysLeft: daysBetween(today, expiresOn),
            },
            targetId: id,
          },
    );
    return 1;
  }

  /** An erased holder's certificates, deleted with their papers. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string; file_id: string | null }[]>`
      SELECT id, file_id FROM staff_certificates
       WHERE account_id = ${accountId}::uuid ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    for (const r of rows)
      if (r.file_id)
        await this.files.markDeleted(
          tx,
          { id: r.file_id, purpose: 'staff_certificate' },
          'erasure',
        );
    await tx.staffCertificate.deleteMany({ where: { accountId } });
    await this.audit.record(tx, {
      action: 'staff_certificate.erased',
      targetId: accountId,
      metadata: { removed: rows.length },
    });
  }

  /** An active staff member, shared-locked, or the field's refusal. */
  private async lockHolder(tx: TenantTxClient, accountId: string) {
    const [holder] = await tx.$queryRaw<{ type: string; status: string }[]>`
      SELECT type::text AS type, status::text AS status FROM accounts
       WHERE id = ${accountId}::uuid FOR SHARE`;
    if (holder?.type !== 'staff' || holder.status !== 'active')
      throw invalid([
        {
          field: 'accountId',
          code: FieldErrorCode.CERTIFICATE_HOLDER_NOT_ELIGIBLE,
        },
      ]);
  }

  /** The live certificate, its holder shared-locked first. */
  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<StaffCertificate> {
    const found = await tx.staffCertificate.findUnique({
      where: { id },
      select: { accountId: true },
    });
    if (!found) throw notFound();
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${found.accountId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM staff_certificates WHERE id = ${id}::uuid FOR UPDATE`;
    const row = await tx.staffCertificate.findUnique({ where: { id } });
    if (!row || row.removedAt) throw notFound();
    return row;
  }

  private async claimFile(tx: TenantTxClient, fileId: string) {
    const file = await this.files.claim(tx, fileId, 'staff_certificate');
    if (!file)
      throw invalid([
        { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
      ]);
    await this.files.attach(tx, file);
    return file.id;
  }

  /** Trimmed words; an empty optional one is none. */
  private words(input: {
    title?: string;
    issuer?: string | null;
    reference?: string | null;
  }): { title?: string; issuer?: string | null; reference?: string | null } {
    const fields: FieldError[] = [];
    const title = input.title?.trim();
    if (input.title !== undefined && !title)
      fields.push({ field: 'title', code: FieldErrorCode.FIELD_REQUIRED });
    if (fields.length) throw invalid(fields);
    const opt = (v: string | null | undefined) =>
      v === undefined ? undefined : v === null ? null : v.trim() || null;
    return {
      title,
      issuer: opt(input.issuer),
      reference: opt(input.reference),
    };
  }

  private async reads(
    tx: TenantTxClient,
    rows: readonly StaffCertificate[],
    today: LocalDate,
    withFile: boolean,
  ): Promise<CertificateRead[]> {
    const holders = new Map(
      (rows.length
        ? await tx.account.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.accountId))] } },
            select: { id: true, fullName: true, status: true },
          })
        : []
      ).map((a) => [a.id, a]),
    );
    const out: CertificateRead[] = [];
    for (const r of rows) {
      const expiresOn = ofDateColumn(r.expiresOn);
      out.push({
        certificate: r,
        holder: holders.get(r.accountId) ?? {
          id: r.accountId,
          fullName: null,
          status: 'erased',
        },
        state: certificateState(expiresOn, today),
        daysLeft: daysBetween(today, expiresOn),
        read:
          withFile && r.fileId ? await this.files.readUrl(tx, r.fileId) : null,
      });
    }
    return out;
  }
}
