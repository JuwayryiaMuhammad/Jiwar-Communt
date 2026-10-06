import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AccountType, DataExport } from '@prisma/client';
import { ClsService } from 'nestjs-cls';
import { AccountLifecycle } from '../accounts/account-lifecycle';
import { AuditService } from '../audit/audit.service';
import { ActionTokens } from '../auth/action-tokens';
import { IdentifierHasher } from '../auth/identifier';
import { OtpService } from '../auth/otp.service';
import { StepUpService } from '../auth/step-up.service';
import type { AppClsStore } from '../common/cls/app-cls';
import { RequestContext } from '../common/cls/request-context';
import { appError, ErrorCode } from '../common/errors';
import type { Locale } from '../common/i18n/locale';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { FilesService } from '../files/files.service';
import {
  ObjectStorage,
  objectKey,
  type PresignedRead,
} from '../files/object-storage';
import { FILE_PURPOSES } from '../files/purposes';
import { EmailTemplates } from '../mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../mail/layout';
import { Outbox } from '../mail/outbox';
import { Notifier } from '../notifications/notifier';
import { RateLimitService } from '../redis/rate-limit.service';
import { SweepRunner } from '../sweep/sweep-runner';
import { ExportSections, type ExportSubject } from './export-sections';
import { ZipStream } from './zip-stream';

export const DATA_EXPORT_BUILD_SWEEP = 'data_exports.build';
export const DATA_EXPORT_EXPIRE_SWEEP = 'data_exports.expire';
export const DATA_EXPORT_LINK_EMAIL = 'data_export.link';

const HOUR = 3_600_000;
/** A ready export can be downloaded this long, then its file is deleted. */
export const EXPORT_TTL_MS = 7 * 24 * HOUR;
/** At most one request per account in this window. */
export const EXPORT_REQUEST_WINDOW_MS = 24 * HOUR;
/** A build's lease; a build that dies is taken again after it. */
export const EXPORT_LEASE_MS = 15 * 60_000;
export const EXPORT_MAX_ATTEMPTS = 3;
/** Successful downloads an assisted export's email link allows. */
export const EXPORT_LINK_MAX_USES = 3;
/** Exports one build run takes per compound. */
const BUILD_BATCH = 2;

/** What the account and its manager see of a request: no content. */
export interface DataExportRead {
  id: string;
  status: DataExport['status'];
  requestedAt: Date;
  readyAt: Date | null;
  expiresAt: Date | null;
  assisted: boolean;
}

interface Claimed {
  id: string;
  tenantId: string;
  accountId: string;
  accountType: AccountType;
  objectId: string;
  attempts: number;
}

/**
 * Personal-data export (ADR 0036): an account's own data in this compound,
 * and what it authored, as the account's own views show them, in a zip of
 * JSON and its own files.
 *
 * - **Request**: a fresh step-up code first (the account's own; an assisted
 *   request has none, it goes only to the account's email), one active
 *   request per account and at most one a day, under the account's row
 *   lock. Frozen and erased accounts are refused.
 * - **Build** (sweep `data_exports.build`, every minute): leased, streamed
 *   section by section into a multipart upload to the private bucket —
 *   never held in memory — then, in one transaction, the `data_export`
 *   file attached to the request, the request ready for 7 days, an inbox
 *   notification with no link, and for an assisted request the email link.
 * - **Download**: in the app, a presigned GET in a no-store response; from
 *   the assisted email, the link plus a one-time code sent to the account's
 *   own email, at most three times.
 * - **Expiry** (sweep `data_exports.expire`): the file is marked deleted and
 *   the files sweep removes it.
 * - Every step is audited with ids and codes only, never content.
 */
@Injectable()
export class DataExportsService implements OnModuleInit {
  private readonly logger = new Logger(DataExportsService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly ctx: RequestContext,
    private readonly cls: ClsService<AppClsStore>,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly templates: EmailTemplates,
    private readonly tokens: ActionTokens,
    private readonly stepUp: StepUpService,
    private readonly otp: OtpService,
    private readonly hasher: IdentifierHasher,
    private readonly storage: ObjectStorage,
    private readonly files: FilesService,
    private readonly sections: ExportSections,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
    private readonly rateLimit: RateLimitService,
  ) {}

  onModuleInit(): void {
    this.sweep.register(DATA_EXPORT_BUILD_SWEEP, (now) => this.buildDue(now), {
      intervalMs: 60_000,
    });
    this.sweep.register(DATA_EXPORT_EXPIRE_SWEEP, (now) => this.expireDue(now));
    // The answer to an explicit request, like a code: never muted or held.
    this.templates.register(
      DATA_EXPORT_LINK_EMAIL,
      (locale, p) => this.renderLink(locale, p),
      { category: 'account_security', critical: true, soleRecord: false },
    );
    // Erasure (ADR 0023): no export of the account survives it.
    this.lifecycle.onErasing(async (tx, account) => {
      const rows = await tx.dataExport.findMany({
        where: {
          accountId: account.id,
          status: { in: ['pending', 'building', 'ready'] },
        },
      });
      const after: (() => Promise<void>)[] = [];
      for (const r of rows) {
        await this.end(
          tx,
          r,
          r.status === 'ready' ? 'expired' : 'failed',
          'account_erased',
        );
        if (r.fileId) {
          await this.files.markDeleted(
            tx,
            { id: r.fileId, purpose: 'data_export' },
            'erasure',
          );
          const fileId = r.fileId;
          after.push(async () => {
            await this.files.purge(fileId);
          });
        } else if (r.objectId) {
          const key = objectKey({ tenantId: r.tenantId, id: r.objectId });
          after.push(async () => {
            await this.storage.delete(key);
          });
        }
      }
      return after;
    });
  }

  // --------------------------------------------------------------------------
  // The account
  // --------------------------------------------------------------------------

  /** The account's own request, behind a fresh step-up on this session. */
  async request(now: Date = new Date()): Promise<DataExportRead> {
    return this.tenantTx.withTenantTx((tx) =>
      this.file(tx, this.ctx.accountId, null, now),
    );
  }

  /**
   * Files a request in the caller's transaction, for the account itself
   * (`assist` null: its step-up is spent) or on its behalf (`assist`: it
   * goes only to the account's own email).
   */
  async file(
    tx: TenantTxClient,
    accountId: string,
    assist: { reasonCode: string } | null,
    now: Date,
  ): Promise<DataExportRead> {
    await tx.$queryRaw`
      SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { status: true, email: true },
    });
    if (!account) throw accountNotFound();
    assertExportable(account, assist !== null);
    if (!assist) await this.stepUp.consume(tx, now);
    const active = await tx.dataExport.count({
      where: { accountId, status: { in: ['pending', 'building'] } },
    });
    if (active) {
      throw appError.conflict(
        ErrorCode.DATA_EXPORT_ACTIVE,
        'An export is already being prepared',
      );
    }
    const last = await tx.dataExport.findFirst({
      where: { accountId },
      orderBy: { requestedAt: 'desc' },
      select: { requestedAt: true },
    });
    if (
      last &&
      last.requestedAt.getTime() > now.getTime() - EXPORT_REQUEST_WINDOW_MS
    ) {
      throw appError.tooManyRequests(
        ErrorCode.DATA_EXPORT_RATE_LIMITED,
        'One export a day',
        {
          params: {
            retryAfter: new Date(
              last.requestedAt.getTime() + EXPORT_REQUEST_WINDOW_MS,
            ).toISOString(),
          },
        },
      );
    }
    const row = await tx.dataExport.create({
      data: {
        id: newId(),
        tenantId: this.ctx.tenantId,
        accountId,
        requestedAt: now,
        requestedByAccountId: this.ctx.accountId,
        assisted: !!assist,
        assistReasonCode: assist?.reasonCode ?? null,
        delivery: assist ? 'email' : 'in_app',
      },
    });
    await this.audit.record(tx, {
      action: 'data_export.requested',
      targetId: row.id,
      metadata: {
        accountId,
        assisted: !!assist,
        delivery: row.delivery,
        ...(assist ? { reasonCode: assist.reasonCode } : {}),
      },
    });
    return read(row);
  }

  /** The account's latest requests, newest first. */
  async mine(): Promise<DataExportRead[]> {
    return this.tenantTx.withTenantTx(async (tx) =>
      (
        await tx.dataExport.findMany({
          where: { accountId: this.ctx.accountId },
          orderBy: { requestedAt: 'desc' },
          take: 10,
        })
      ).map(read),
    );
  }

  /** A download URL for the account's own ready export (no-store). */
  async downloadUrl(
    id: string,
    now: Date = new Date(),
  ): Promise<PresignedRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.dataExport.findFirst({
        where: { id, accountId: this.ctx.accountId },
      });
      const url = await this.presign(row, now);
      await this.audit.record(tx, {
        action: 'data_export.downloaded',
        targetId: id,
        metadata: { via: 'app' },
      });
      return url;
    });
  }

  // --------------------------------------------------------------------------
  // The assisted email's link (public)
  // --------------------------------------------------------------------------

  /**
   * Sends a one-time code to the account's own email for the link's
   * export: the link alone downloads nothing (ADR 0036).
   */
  async sendDownloadCode(
    token: string,
    ip: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.limit(ip, token);
    const target = await this.tokens.inTokenTenant(
      token,
      'export_download',
      async (tx, row) => {
        const exp = await tx.dataExport.findFirst({
          where: { id: row.subjectId, status: 'ready', expiresAt: { gt: now } },
          select: { id: true },
        });
        const holder = await tx.account.findUnique({
          where: { id: row.accountId },
          select: { email: true, preferredLocale: true, status: true },
        });
        if (!exp || !holder?.email || !exportable(holder.status))
          throw tokenInvalid();
        return {
          tokenId: row.id,
          accountId: row.accountId,
          email: holder.email,
          locale: holder.preferredLocale,
        };
      },
      now,
    );
    // After the transaction: the code is mailed directly, like a login code.
    await this.otp.issueForStepUp(
      this.hasher.stepUpKey('action-token', target.tokenId),
      target.accountId,
      target.email,
      target.locale,
    );
  }

  /**
   * The link and its code: a presigned GET (no-store). Each success is
   * counted; the third is the last.
   */
  async downloadByToken(
    token: string,
    code: string,
    ip: string,
    now: Date = new Date(),
  ): Promise<PresignedRead> {
    await this.limit(ip, token);
    return this.tokens.inTokenTenant(
      token,
      'export_download',
      async (tx, row) => {
        const ok = await this.otp.verifyStepUp(
          this.hasher.stepUpKey('action-token', row.id),
          code,
        );
        if (!ok) {
          throw appError.forbidden(
            ErrorCode.STEP_UP_CODE_INVALID,
            'Invalid or expired code',
          );
        }
        const exp = await tx.dataExport.findFirst({
          where: { id: row.subjectId, accountId: row.accountId },
        });
        const url = await this.presign(exp, now, tokenInvalid);
        const use = await this.tokens.use(tx, row.id, EXPORT_LINK_MAX_USES);
        await this.audit.record(tx, {
          action: 'data_export.downloaded',
          targetId: row.subjectId,
          metadata: { via: 'email_link', use },
        });
        return url;
      },
      now,
    );
  }

  // --------------------------------------------------------------------------
  // The sweeps
  // --------------------------------------------------------------------------

  /**
   * Claims due exports (pending, or building with an expired lease) under
   * SKIP LOCKED, then builds each outside any transaction.
   */
  async buildDue(now: Date = new Date()): Promise<number> {
    const claimed: Claimed[] = [];
    const stale: string[] = [];
    await this.sweep.forEachTenant(async (tx, tenantId) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          account_id: string;
          attempts: number;
          object_id: string | null;
        }[]
      >`
        SELECT id, account_id, attempts, object_id FROM data_exports
         WHERE status = 'pending'
            OR (status = 'building' AND locked_until < ${now})
         ORDER BY requested_at, id
         LIMIT ${BUILD_BATCH}
           FOR UPDATE SKIP LOCKED`;
      for (const r of rows) {
        if (r.object_id) stale.push(objectKey({ tenantId, id: r.object_id }));
        const row = await tx.dataExport.findUniqueOrThrow({
          where: { id: r.id },
        });
        const account = await tx.account.findUniqueOrThrow({
          where: { id: r.account_id },
          select: { type: true, status: true },
        });
        if (!exportable(account.status)) {
          await this.end(tx, row, 'failed', 'account_not_eligible');
          continue;
        }
        if (r.attempts >= EXPORT_MAX_ATTEMPTS) {
          await this.end(tx, row, 'failed', 'build_failed');
          continue;
        }
        const objectId = newId();
        await tx.dataExport.update({
          where: { id: r.id },
          data: {
            status: 'building',
            attempts: { increment: 1 },
            lockedUntil: new Date(now.getTime() + EXPORT_LEASE_MS),
            objectId,
          },
        });
        claimed.push({
          id: r.id,
          tenantId,
          accountId: r.account_id,
          accountType: account.type,
          objectId,
          attempts: r.attempts + 1,
        });
      }
      return rows.length;
    });
    // A build that died left its object behind: it never outlives its row.
    for (const key of stale) await this.storage.delete(key);
    for (const c of claimed) await this.buildOne(c);
    return claimed.length;
  }

  /** Expires ready exports past their 7 days; their files go. */
  async expireDue(now: Date = new Date()): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM data_exports
         WHERE status = 'ready' AND expires_at <= ${now}
         ORDER BY expires_at LIMIT 200
           FOR UPDATE SKIP LOCKED`;
      for (const { id } of due) {
        const row = await tx.dataExport.findUniqueOrThrow({ where: { id } });
        await this.end(tx, row, 'expired', null);
        if (row.fileId)
          await this.files.markDeleted(
            tx,
            { id: row.fileId, purpose: 'data_export' },
            'retention',
          );
      }
      return due.length;
    });
  }

  // --------------------------------------------------------------------------

  private async buildOne(c: Claimed): Promise<void> {
    const key = objectKey({ tenantId: c.tenantId, id: c.objectId });
    try {
      const size = await this.asAccount(c, () => this.write(c, key));
      const attached = await this.asAccount(c, () =>
        this.tenantTx.withTenantTx((tx) => this.finish(tx, c, size)),
      );
      // Frozen or erased while it was built: ended, and its bytes go.
      if (!attached) await this.storage.delete(key);
    } catch (error) {
      this.logger.error(
        `export ${c.id} failed (${error instanceof Error ? error.name : 'Error'})`,
      );
      await this.storage.delete(key);
      await this.asAccount(c, () =>
        this.tenantTx.withTenantTx(async (tx) => {
          const row = await tx.dataExport.findUnique({ where: { id: c.id } });
          if (row?.status !== 'building' || row.objectId !== c.objectId) return;
          if (
            c.attempts >= EXPORT_MAX_ATTEMPTS ||
            (error instanceof Error && error.name === 'ExportTooLargeError')
          )
            await this.end(
              tx,
              row,
              'failed',
              error instanceof Error && error.name === 'ExportTooLargeError'
                ? 'too_large'
                : 'build_failed',
            );
          else
            await tx.dataExport.update({
              where: { id: c.id },
              data: { status: 'pending', lockedUntil: null },
            });
        }),
      );
    }
  }

  /** The archive, streamed into the store; returns its size in bytes. */
  private async write(c: Claimed, key: string): Promise<number> {
    const zip = new ZipStream(FILE_PURPOSES.data_export.maxBytes);
    const upload = this.storage.putStream(key, 'application/zip', zip.output);
    // A failing upload stops the writer instead of leaving it waiting.
    upload.catch((error: unknown) =>
      zip.output.destroy(error instanceof Error ? error : new Error('upload')),
    );
    const subject: ExportSubject = {
      accountId: c.accountId,
      tenantId: c.tenantId,
      accountType: c.accountType,
    };
    try {
      await zip.addJson('README.json', {
        format: 'jiwar-export/1',
        exportId: c.id,
        generatedAt: new Date().toISOString(),
        sections: this.sections.all().map(([name]) => name),
      });
      for (const [, section] of this.sections.all()) {
        for await (const entry of section(subject)) {
          if ('json' in entry) await zip.addJson(entry.path, entry.json);
          else
            await zip.addStream(
              entry.path,
              await this.ownFile(subject, entry.fileId),
            );
        }
      }
      await zip.end();
      await upload;
    } catch (error) {
      zip.output.destroy();
      await upload.catch(() => undefined);
      throw error;
    }
    return zip.bytes;
  }

  /**
   * One of the account's own files (its photo, or a file it owns), as a
   * stream from the store; anything else is refused.
   */
  private async ownFile(subject: ExportSubject, fileId: string) {
    const file = await this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.account.findUniqueOrThrow({
        where: { id: subject.accountId },
        select: { photoFileId: true },
      });
      return tx.storedFile.findFirst({
        where: {
          id: fileId,
          status: 'ready',
          deletedAt: null,
          purpose: { not: 'data_export' },
          OR: [
            { ownerAccountId: subject.accountId },
            ...(account.photoFileId === fileId ? [{ id: fileId }] : []),
          ],
        },
        select: { id: true, tenantId: true },
      });
    });
    if (!file) throw new Error('Not one of the account’s own files');
    return this.storage.readStream(objectKey(file));
  }

  /**
   * The archive is in the store: attach it and tell the account. False when
   * the account can no longer export (the request is ended instead).
   */
  private async finish(
    tx: TenantTxClient,
    c: Claimed,
    size: number,
  ): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM data_exports WHERE id = ${c.id}::uuid FOR UPDATE`;
    const row = await tx.dataExport.findUniqueOrThrow({ where: { id: c.id } });
    if (row.status !== 'building' || row.objectId !== c.objectId)
      throw new Error('The build lost its lease');
    const holder = await tx.account.findUniqueOrThrow({
      where: { id: c.accountId },
      select: { status: true, email: true, preferredLocale: true },
    });
    if (!exportable(holder.status)) {
      await this.end(tx, row, 'failed', 'account_not_eligible');
      return false;
    }
    const finished = new Date();
    await tx.storedFile.create({
      data: {
        id: c.objectId,
        tenantId: c.tenantId,
        ownerAccountId: null,
        purpose: 'data_export',
        contentType: 'application/zip',
        sizeBytes: size,
        status: 'ready',
        uploadExpiresAt: finished,
        finalizedAt: finished,
        attachedAt: finished,
      },
    });
    const expiresAt = new Date(finished.getTime() + EXPORT_TTL_MS);
    await tx.dataExport.update({
      where: { id: c.id },
      data: {
        status: 'ready',
        fileId: c.objectId,
        readyAt: finished,
        expiresAt,
        lockedUntil: null,
      },
    });
    await this.audit.record(tx, {
      action: 'data_export.ready',
      targetId: c.id,
      metadata: { attempts: c.attempts },
    });
    // The inbox, with no link: the app downloads with the account's session.
    await this.notifier.notify(tx, [c.accountId], {
      kind: 'data_export.ready',
      params: { expiresAt: expiresAt.toISOString() },
      targetId: c.id,
    });
    if (row.delivery === 'email' && holder.email) {
      const tokenId = await this.tokens.create(tx, {
        tenantId: c.tenantId,
        accountId: c.accountId,
        purpose: 'export_download',
        subjectId: c.id,
        expiresAt,
      });
      const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
        where: { id: c.tenantId },
        select: { name: true },
      });
      await this.outbox.enqueue(tx, {
        tenantId: c.tenantId,
        templateKey: DATA_EXPORT_LINK_EMAIL,
        locale: holder.preferredLocale,
        recipient: holder.email,
        // The link is made at send time from the token row's id.
        params: {
          compoundName: tenant.name,
          expiresAt: expiresAt.toISOString(),
          actionTokenId: tokenId,
        },
        recipientAccountId: c.accountId,
      });
    }
    return true;
  }

  /** Ends a request (expired or failed) and closes its link. */
  private async end(
    tx: TenantTxClient,
    row: DataExport,
    status: 'expired' | 'failed',
    failureCode: string | null,
  ): Promise<void> {
    await tx.dataExport.update({
      where: { id: row.id },
      data: {
        status,
        endedAt: new Date(),
        fileId: null,
        lockedUntil: null,
        failureCode: status === 'failed' ? failureCode : null,
      },
    });
    await this.globalDb.in(tx).actionToken.updateMany({
      where: { subjectId: row.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await this.audit.record(tx, {
      action:
        status === 'expired' ? 'data_export.expired' : 'data_export.failed',
      targetId: row.id,
      metadata: failureCode ? { reasonCode: failureCode } : {},
    });
  }

  private async presign(
    row: DataExport | null,
    now: Date,
    notFound: () => Error = exportNotFound,
  ): Promise<PresignedRead> {
    if (
      !row ||
      row.status !== 'ready' ||
      !row.fileId ||
      !row.expiresAt ||
      row.expiresAt <= now
    )
      throw notFound();
    return this.storage.presignGet(
      objectKey({ tenantId: row.tenantId, id: row.fileId }),
      {
        downloadName: `jiwar-export-${row.readyAt!.toISOString().slice(0, 10)}.zip`,
      },
    );
  }

  /** Runs `fn` as the export's account: the sections read as it would. */
  private asAccount<T>(c: Claimed, fn: () => Promise<T>): Promise<T> {
    return this.cls.run(async () => {
      this.cls.set('tenantId', c.tenantId);
      this.cls.set('accountId', c.accountId);
      this.cls.set('accountType', c.accountType);
      this.cls.set('auditActor', { type: 'system', id: null });
      return await fn();
    });
  }

  private async limit(ip: string, token: string): Promise<void> {
    const window = this.config.get('OTP_RATE_LIMIT_WINDOW_SECONDS', {
      infer: true,
    });
    await this.rateLimit.consume(
      `export-link:ip:${ip}`,
      this.config.get('OTP_RATE_LIMIT_PER_IP', { infer: true }),
      window,
    );
    await this.rateLimit.consume(
      `export-link:token:${(token ?? '').slice(0, 36)}`,
      this.config.get('OTP_RATE_LIMIT_PER_IDENTIFIER', { infer: true }),
      window,
    );
  }

  private renderLink(
    locale: Locale,
    p: Record<string, unknown>,
  ): RenderedEmail {
    const link = this.tokens.link(String(p.actionTokenId), 'export_download');
    const until = String(p.expiresAt).slice(0, 10);
    const compound = String(p.compoundName);
    const t =
      locale === 'ar'
        ? {
            subject: 'نسخة بياناتك على جوار جاهزة',
            lead: `نسخة بياناتك الشخصية في ${compound} جاهزة للتنزيل حتى ${until}.`,
            action: 'افتح الرابط، وسيصلك رمز إلى هذا البريد لتأكيد التنزيل:',
            help: 'إذا لم تطلب نسخة من بياناتك، تجاهل هذه الرسالة وأبلغ إدارة المجمع.',
          }
        : {
            subject: 'Your Jiwar data export is ready',
            lead: `The copy of your personal data in ${compound} can be downloaded until ${until}.`,
            action:
              'Open the link; a code sent to this email confirms the download:',
            help: 'If you did not ask for a copy of your data, ignore this email and tell the compound management.',
          };
    const lines = [t.lead, '', t.action, link, '', t.help];
    return {
      subject: t.subject,
      text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
      html: emailPage(
        locale,
        `<p>${escapeHtml(t.lead)}</p><p>${escapeHtml(t.action)}</p><p dir="ltr"><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p style="color:#666">${escapeHtml(t.help)}</p>`,
      ),
    };
  }
}

/** Only an account that still exists and is not frozen exports. */
function exportable(status: string): boolean {
  return status === 'active' || status === 'inactive';
}

/**
 * Whether an export may be filed for the account (ADR 0036). Frozen and
 * erased accounts never; an assisted one only to the account's own email,
 * so an account without one is refused (ACCOUNT_HAS_NO_EMAIL) — today no
 * account that may export lacks one (accounts_erased_shape).
 */
export function assertExportable(
  account: { status: string; email: string | null },
  assisted: boolean,
): void {
  if (!exportable(account.status)) {
    throw appError.conflict(
      ErrorCode.ACCOUNT_NOT_ELIGIBLE,
      'This account cannot export its data',
    );
  }
  if (assisted && !account.email) {
    throw appError.conflict(
      ErrorCode.ACCOUNT_HAS_NO_EMAIL,
      'An assisted export goes only to the account’s own email',
    );
  }
}

function read(r: DataExport): DataExportRead {
  return {
    id: r.id,
    status: r.status,
    requestedAt: r.requestedAt,
    readyAt: r.readyAt,
    expiresAt: r.expiresAt,
    assisted: r.assisted,
  };
}

function exportNotFound() {
  return appError.notFound(ErrorCode.DATA_EXPORT_NOT_FOUND, 'Export not found');
}

function tokenInvalid() {
  return appError.notFound(
    ErrorCode.ACTION_TOKEN_INVALID,
    'This link is not valid any more',
  );
}

function accountNotFound() {
  return appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Account not found');
}
