import { randomBytes } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OfficialLetter, Prisma } from '@prisma/client';
import { CommunityManagementPort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { drawCertificate } from '../../core/pdf/certificate';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';
import { RequestAccess } from '../requests/request-access';
import {
  letterCodeHash,
  letterNumber,
  statement,
  TITLES,
  type LetterKind,
} from './letter-rules';

export interface NewLetter {
  kind: LetterKind;
  unitId: string;
  /** The owner or tenant it names: an active occupancy of the unit. */
  accountId: string;
  /** The `documents` request it answers: one of the account's. */
  requestId?: string;
  addressee?: string;
  subject?: string;
}

export interface LettersQuery {
  unitId?: string;
  accountId?: string;
  cursor?: string;
  limit?: number;
}

/** A letter as it is read: the row and the unit's code. */
export interface LetterRead {
  letter: OfficialLetter;
  unitCode: string;
  status: 'valid' | 'revoked';
}

/** What the public check tells: validity, the issuer and the day. Nothing else. */
export interface PublicLetter {
  status: 'valid' | 'revoked';
  issuer: string;
  issuedOn: string;
}

const PAGE = keysetCursor('issuedAt');

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const letterNotFound = () =>
  appError.notFound(ErrorCode.OFFICIAL_LETTER_NOT_FOUND, 'Letter not found');

const statusOf = (l: OfficialLetter) => (l.revokedAt ? 'revoked' : 'valid');

/**
 * Official letters (ADR 0080, `letters.issue`): a residence confirmation, a
 * no-objection letter or a letter to whom it may concern, issued for an
 * owner or a tenant of a unit, often in answer to a `documents` request. A
 * letter is a record: its words come from its kind and the facts frozen at
 * its issue (the name as written then, the capacity and since when), and
 * the PDF is drawn on demand from it (core PdfRenderer, certificate.v2), the
 * same bytes each time. It prints a 22-character code that the public page
 * checks; the code is kept on the row, its SHA-256 in a global pointer, as
 * a clearance's (ADR 0062). Revoked once, with a code; never deleted.
 *
 * The name is the one personal value: the subject's erasure clears it, the
 * letter stays (its check still answers) and its PDF is no longer drawn.
 */
@Injectable()
export class LettersService implements OnModuleInit {
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly globalDb: GlobalDbService,
    private readonly access: RequestAccess,
    private readonly community: CommunityManagementPort,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly pdf: PdfRenderer,
    private readonly lifecycle: AccountLifecycle,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  onModuleInit(): void {
    // Erasure (ADR 0023): the name written on the account's letters goes,
    // in the erasure's transaction (the trigger lets that one change
    // through); the letters, their numbers and their checks stay.
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.$executeRaw`
        UPDATE official_letters
           SET subject_name = NULL, erased_at = date_trunc('milliseconds', now())
         WHERE account_id = ${account.id}::uuid AND subject_name IS NOT NULL`;
      return [];
    });
  }

  issue(input: NewLetter): Promise<LetterRead> {
    const addressee = input.addressee?.trim() || null;
    const subject = input.subject?.trim() || null;
    if (input.kind === 'no_objection' && !subject)
      throw invalid([
        { field: 'subject', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const unit = await this.community.unitPlace(tx, input.unitId);
      if (!unit)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      if (input.requestId) {
        const request = await tx.managementRequest.findFirst({
          where: { id: input.requestId, authorId: input.accountId },
          select: { id: true },
        });
        if (!request)
          throw invalid([
            { field: 'requestId', code: FieldErrorCode.INVALID_VALUE },
          ]);
      }
      // The place it states, held FOR SHARE until the commit.
      const who = await this.community.letterSubject(
        tx,
        input.accountId,
        input.unitId,
      );
      if (!who)
        throw appError.conflict(
          ErrorCode.OFFICIAL_LETTER_NOT_OCCUPANT,
          'The account holds no place in this unit now',
        );
      const tenantId = this.ctx.tenantId;
      const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
        INSERT INTO official_letter_counters (tenant_id, last_number)
        VALUES (${tenantId}::uuid, 1)
        ON CONFLICT (tenant_id)
          DO UPDATE SET last_number = official_letter_counters.last_number + 1
        RETURNING last_number AS number`;
      const now = await dbNow(tx);
      const { timezone } = await this.settings.inTx(tx, tenantId);
      const verifyCode = randomBytes(16).toString('base64url');
      const letter = await tx.officialLetter.create({
        data: {
          id: newId(),
          tenantId,
          number,
          kind: input.kind,
          unitId: unit.id,
          accountId: input.accountId,
          requestId: input.requestId ?? null,
          subjectName: who.fullName,
          occupancyType: who.occupancyType,
          occupancySince: new Date(localDay(who.since, timezone)),
          addressee,
          subject,
          issuedById: this.ctx.accountId,
          issuedAt: now,
          verifyCode,
          template: 'certificate.v2',
        },
      });
      await this.globalDb.in(tx).officialLetterLink.create({
        data: {
          codeHash: letterCodeHash(verifyCode),
          tenantId,
          letterId: letter.id,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'official_letter.issued',
        targetId: letter.id,
        metadata: {
          number: letterNumber(number),
          kind: input.kind,
          unitId: unit.id,
          accountId: input.accountId,
          withRequest: input.requestId !== undefined,
          withAddressee: addressee !== null,
          withSubject: subject !== null,
        },
      });
      await this.notifier.notify(tx, [input.accountId], {
        kind: 'official_letter.issued',
        params: { letterNumber: letterNumber(number), letterKind: input.kind },
        targetId: letter.id,
      });
      return { letter, unitCode: unit.code, status: 'valid' };
    });
  }

  /** Revoked once, with a code; the public check then says so. */
  revoke(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.officialLetterRevoke,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$queryRaw`SELECT id FROM official_letters WHERE id = ${id}::uuid FOR UPDATE`;
      const letter = await tx.officialLetter.findUnique({ where: { id } });
      if (!letter) throw letterNotFound();
      if (letter.revokedAt)
        throw appError.conflict(
          ErrorCode.OFFICIAL_LETTER_REVOKED,
          'The letter is revoked already',
          { params: { revokedAt: letter.revokedAt.toISOString() } },
        );
      await tx.officialLetter.update({
        where: { id },
        data: {
          revokedAt: await dbNow(tx),
          revokedById: this.ctx.accountId,
          revokeReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'official_letter.revoked',
        targetId: id,
        metadata: { number: letterNumber(letter.number), reasonCode: reason },
      });
    });
  }

  /** The compound's letters, the newest first. */
  list(q: LettersQuery): Promise<Page<LetterRead>> {
    return this.page(
      {
        ...(q.unitId ? { unitId: q.unitId } : {}),
        ...(q.accountId ? { accountId: q.accountId } : {}),
      },
      q,
    );
  }

  /** The caller's own letters, the newest first. */
  mine(q: { cursor?: string; limit?: number }): Promise<Page<LetterRead>> {
    return this.forAccount(this.ctx.accountId, q);
  }

  /** The letters that name an account (its own list, its export). */
  forAccount(
    accountId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<LetterRead>> {
    return this.page({ accountId }, q);
  }

  get(id: string, own: boolean): Promise<LetterRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const letter = await tx.officialLetter.findFirst({
        where: { id, ...(own ? { accountId: this.ctx.accountId } : {}) },
      });
      if (!letter) throw letterNotFound();
      return (await this.reads(tx, [letter]))[0];
    });
  }

  /**
   * The letter as a PDF, drawn from the record: the staff's, or its
   * subject's own (`own`). A revoked letter still prints, marked by its
   * check; an erased subject's no longer does (OFFICIAL_LETTER_ERASED).
   */
  document(id: string, own: boolean): Promise<{ name: string; body: Buffer }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const letter = await tx.officialLetter.findFirst({
        where: { id, ...(own ? { accountId: this.ctx.accountId } : {}) },
      });
      if (!letter) throw letterNotFound();
      if (letter.subjectName === null)
        throw appError.conflict(
          ErrorCode.OFFICIAL_LETTER_ERASED,
          'The letter’s subject was erased',
        );
      const unit = (await this.community.unitPlace(tx, letter.unitId))!;
      const { name: compound } = await this.globalDb
        .in(tx)
        .tenant.findUniqueOrThrow({
          where: { id: letter.tenantId },
          select: { name: true },
        });
      const { timezone } = await this.settings.inTx(tx, letter.tenantId);
      const issued = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeZone: timezone,
      }).format(letter.issuedAt);
      const since = letter.occupancySince.toISOString().slice(0, 10);
      const kind = letter.kind as LetterKind;
      const number = letterNumber(letter.number);
      const says = statement(kind, {
        name: letter.subjectName,
        unitCode: unit.code,
        capacity: letter.occupancyType,
        since,
        subject: letter.subject,
      });
      const body = await this.pdf.render(
        { title: number, createdAt: letter.issuedAt },
        (page) =>
          drawCertificate(page, {
            template: 'certificate.v2',
            compound,
            titleEn: TITLES[kind].en,
            titleAr: TITLES[kind].ar,
            number,
            rows: [
              ...(letter.addressee
                ? [{ labelEn: 'To', labelAr: 'إلى', value: letter.addressee }]
                : []),
              { labelEn: 'Name', labelAr: 'الاسم', value: letter.subjectName! },
              // The code and the building apart, as on a clearance.
              { labelEn: 'Unit', labelAr: 'الوحدة', value: unit.code },
              ...(unit.building
                ? [
                    {
                      labelEn: 'Building',
                      labelAr: 'المبنى',
                      value: unit.building,
                    },
                  ]
                : []),
              { labelEn: 'Since', labelAr: 'منذ', value: since },
              { labelEn: 'Issued', labelAr: 'تاريخ الإصدار', value: issued },
            ],
            statementEn: says.en,
            statementAr: says.ar,
            verifyUrl: `${this.appUrl}/l`,
            verifyCode: letter.verifyCode,
          }),
      );
      return { name: `${number}.pdf`, body };
    });
  }

  /**
   * The public check (letter-page.service.ts), in the letter's compound:
   * whether it stands, who issued it and on which day. Never a name, a
   * unit or what it says.
   */
  async publicOf(
    tx: TenantTxClient,
    letterId: string,
    code: string,
    issuer: string,
  ): Promise<PublicLetter | null> {
    const letter = await tx.officialLetter.findUnique({
      where: { id: letterId },
    });
    // The pointer must name this very code: a hash collision opens nothing.
    if (!letter || letter.verifyCode !== code) return null;
    const { timezone } = await this.settings.inTx(tx, letter.tenantId);
    return {
      status: statusOf(letter),
      issuer,
      issuedOn: localDay(letter.issuedAt, timezone),
    };
  }

  private page(
    where: Prisma.OfficialLetterWhereInput,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<LetterRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const limit = clampLimit(q.limit);
      const rows = await tx.officialLetter.findMany({
        where: { AND: [where, ...PAGE.after(q.cursor)] },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { ...page, items: await this.reads(tx, page.items) };
    });
  }

  private async reads(
    tx: TenantTxClient,
    rows: OfficialLetter[],
  ): Promise<LetterRead[]> {
    const codes = await this.community.unitCodes(
      tx,
      rows.map((r) => r.unitId),
    );
    return rows.map((letter) => ({
      letter,
      unitCode: codes.get(letter.unitId) ?? '',
      status: statusOf(letter),
    }));
  }
}

/** An instant's day in the compound's zone, `YYYY-MM-DD`. */
function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
