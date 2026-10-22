import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FormalNotice, Prisma } from '@prisma/client';
import type { Locale } from '../common/i18n/locale';
import { RequestContext } from '../common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../common/cursor';
import { appError, ErrorCode } from '../common/errors';
import { newId } from '../common/uuid';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import { ExportSections } from '../exports/export-sections';
import { EmailTemplates } from '../mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../mail/layout';
import { Outbox } from '../mail/outbox';
import { Notifier } from '../notifications/notifier';
import {
  ResidentItems,
  type ResidentItem,
} from '../resident-items/resident-items';

/** The kinds of formal notice (ADR 0058): a closed list. */
export const FORMAL_NOTICE_TYPES = ['late_payment'] as const;
export type FormalNoticeType = (typeof FORMAL_NOTICE_TYPES)[number];

export const LATE_PAYMENT_EMAIL = 'formal_notice.late_payment';

/** `FN-000123`. */
export const noticeNumber = (n: number) => `FN-${String(n).padStart(6, '0')}`;

export interface NoticeInput {
  type: FormalNoticeType;
  unitId: string;
  subjectType: 'invoice';
  subjectId: string;
  /** The subject's own reference, for the email (`INV-000123`). */
  subjectNumber: string;
  amount: Prisma.Decimal;
  /** The local day it was due, `YYYY-MM-DD`. */
  dueOn: string;
  recipients: readonly string[];
}

export interface MyNotice {
  notice: FormalNotice;
  deliveredAt: Date;
  emailedAt: Date | null;
  readAt: Date | null;
}

const PAGE = keysetCursor('deliveredAt');

/**
 * Formal notices (ADR 0058): a decision about a unit that must be proven
 * delivered and read. A domain issues one in its own transaction (finance:
 * a late payment); the notice is the compound's record and never changes.
 * Each recipient gets an inbox row (the delivery, at issue), an email
 * whatever their preferences (its sending is copied here by the outbox),
 * and their first opening is recorded. Codes, amounts and dates only.
 */
@Injectable()
export class FormalNotices implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly globalDb: GlobalDbService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly templates: EmailTemplates,
    private readonly items: ResidentItems,
    private readonly sections: ExportSections,
  ) {}

  onModuleInit(): void {
    // Critical: a formal notice is sent whatever the preferences say.
    this.templates.register(
      LATE_PAYMENT_EMAIL,
      (locale, p) => render(locale, p),
      { category: 'finance', critical: true, soleRecord: false },
    );
    this.items.register({
      type: 'formal_notice',
      group: null,
      search: async (tx, q, take) =>
        q.number !== null && (q.prefix === null || q.prefix === 'FN')
          ? (await this.read(tx, { number: q.number }, take)).map(item)
          : [],
    });
    this.sections.register('notices', (s) => this.exported(s.accountId));
  }

  /**
   * Issues a notice, once per type and subject: null when one exists. The
   * caller holds its subject's lock and has checked it is due.
   */
  async issue(
    tx: TenantTxClient,
    input: NoticeInput,
  ): Promise<{ id: string; number: string } | null> {
    const exists = await tx.formalNotice.count({
      where: {
        type: input.type,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
      },
    });
    if (exists) return null;
    const tenantId = this.ctx.txTenantId;
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO formal_notice_counters (tenant_id, last_number)
      VALUES (${tenantId}::uuid, 1)
      ON CONFLICT (tenant_id)
        DO UPDATE SET last_number = formal_notice_counters.last_number + 1
      RETURNING last_number AS number`;
    const id = newId();
    const notice = await tx.formalNotice.create({
      data: {
        id,
        tenantId,
        number,
        type: input.type,
        unitId: input.unitId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        amount: input.amount,
        dueOn: new Date(`${input.dueOn}T00:00:00Z`),
      },
    });
    const holders = await tx.account.findMany({
      where: { id: { in: [...input.recipients] }, status: 'active' },
      select: { id: true, email: true, preferredLocale: true },
    });
    if (!holders.length) return { id, number: noticeNumber(number) };
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true },
    });
    for (const holder of holders) {
      const recipientId = newId();
      await tx.formalNoticeRecipient.create({
        data: {
          id: recipientId,
          tenantId,
          noticeId: id,
          accountId: holder.id,
          deliveredAt: notice.issuedAt,
        },
      });
      if (holder.email)
        await this.outbox.enqueue(tx, {
          tenantId,
          templateKey: LATE_PAYMENT_EMAIL,
          locale: holder.preferredLocale,
          recipient: holder.email,
          params: {
            compoundName: tenant.name,
            noticeNumber: noticeNumber(number),
            subjectNumber: input.subjectNumber,
            amount: input.amount.toFixed(2),
            dueOn: input.dueOn,
          },
          recipientAccountId: holder.id,
          formalNoticeRecipientId: recipientId,
        });
    }
    await this.notifier.notify(
      tx,
      holders.map((h) => h.id),
      {
        kind: 'formal_notice.issued',
        params: { type: input.type },
        targetId: id,
      },
    );
    return { id, number: noticeNumber(number) };
  }

  /** The caller's notices, newest first. */
  mine(q: { cursor?: string; limit?: number }): Promise<Page<MyNotice>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.formalNoticeRecipient.findMany({
        where: {
          AND: [
            { accountId: this.ctx.accountId },
            ...(PAGE.after(
              q.cursor,
            ) as Prisma.FormalNoticeRecipientWhereInput[]),
          ],
        },
        include: { notice: true },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return { nextCursor: page.nextCursor, items: page.items.map(mineOf) };
    });
  }

  /**
   * One of the caller's notices; the first opening is its read proof, by
   * the database's clock, once. Anyone else's is FORMAL_NOTICE_NOT_FOUND.
   */
  open(id: string): Promise<MyNotice> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$executeRaw`
        UPDATE formal_notice_recipients SET read_at = now()
         WHERE notice_id = ${id}::uuid
           AND account_id = ${this.ctx.accountId}::uuid
           AND read_at IS NULL`;
      const row = await tx.formalNoticeRecipient.findFirst({
        where: { noticeId: id, accountId: this.ctx.accountId },
        include: { notice: true },
      });
      if (!row)
        throw appError.notFound(
          ErrorCode.FORMAL_NOTICE_NOT_FOUND,
          'Notice not found',
        );
      return mineOf(row);
    });
  }

  /** The staff's list of a type, newest first, with every proof. */
  forStaff(
    type: FormalNoticeType,
    q: { cursor?: string; limit?: number },
  ): Promise<
    Page<
      FormalNotice & {
        recipients: {
          accountId: string;
          deliveredAt: Date;
          emailedAt: Date | null;
          readAt: Date | null;
        }[];
      }
    >
  > {
    const limit = clampLimit(q.limit);
    const cursor = keysetCursor('issuedAt');
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.formalNotice.findMany({
        where: {
          AND: [
            { type },
            ...(cursor.after(q.cursor) as Prisma.FormalNoticeWhereInput[]),
          ],
        },
        include: {
          recipients: {
            select: {
              accountId: true,
              deliveredAt: true,
              emailedAt: true,
              readAt: true,
            },
            orderBy: { accountId: 'asc' },
          },
        },
        orderBy: cursor.orderBy,
        take: limit + 1,
      });
      return cursor.toPage(rows, limit);
    });
  }

  private async read(
    tx: TenantTxClient,
    where: Prisma.FormalNoticeWhereInput,
    take: number,
  ): Promise<FormalNotice[]> {
    return tx.formalNotice.findMany({
      where: {
        AND: [
          where,
          { recipients: { some: { accountId: this.ctx.accountId } } },
        ],
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
      take,
    });
  }

  private async *exported(accountId: string) {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.formalNoticeRecipient.findMany({
        where: { accountId },
        include: { notice: true },
        orderBy: [{ deliveredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    yield {
      path: 'notices.json',
      json: rows.map((r) => {
        const m = mineOf(r);
        return {
          number: noticeNumber(m.notice.number),
          type: m.notice.type,
          unitId: m.notice.unitId,
          amount: m.notice.amount.toFixed(2),
          dueOn: m.notice.dueOn.toISOString().slice(0, 10),
          issuedAt: m.notice.issuedAt,
          deliveredAt: m.deliveredAt,
          emailedAt: m.emailedAt,
          readAt: m.readAt,
        };
      }),
    };
  }
}

function mineOf(r: {
  notice: FormalNotice;
  deliveredAt: Date;
  emailedAt: Date | null;
  readAt: Date | null;
}): MyNotice {
  return {
    notice: r.notice,
    deliveredAt: r.deliveredAt,
    emailedAt: r.emailedAt,
    readAt: r.readAt,
  };
}

const item = (n: FormalNotice): ResidentItem => ({
  type: 'formal_notice',
  id: n.id,
  number: noticeNumber(n.number),
  status: 'issued',
  lastActivityAt: n.issuedAt,
  unitId: n.unitId,
  kind: n.type,
  categoryKey: null,
  topicKey: null,
  requestType: null,
  appeal: null,
});

/** The late-payment notice's email: the facts, and what to do. */
function render(locale: Locale, p: Record<string, unknown>): RenderedEmail {
  const compound = String(p.compoundName);
  const t =
    locale === 'ar'
      ? {
          subject: `إنذار رسمي ${String(p.noticeNumber)}: فاتورة متأخرة`,
          lead: `إنذار رسمي من إدارة ${compound} (${String(p.noticeNumber)}).`,
          body: `الفاتورة ${String(p.subjectNumber)} المستحقة في ${String(p.dueOn)} ما زال عليها ${String(p.amount)} جنيه.`,
          action:
            'يُرجى السداد أو التواصل مع الإدارة من التطبيق. يُسجَّل فتحك لهذا الإنذار في التطبيق.',
        }
      : {
          subject: `Formal notice ${String(p.noticeNumber)}: a late invoice`,
          lead: `A formal notice from the management of ${compound} (${String(p.noticeNumber)}).`,
          body: `Invoice ${String(p.subjectNumber)}, due on ${String(p.dueOn)}, still owes EGP ${String(p.amount)}.`,
          action:
            'Please pay, or contact the management in the app. Opening this notice in the app is recorded.',
        };
  const lines = [t.lead, '', t.body, '', t.action];
  return {
    subject: t.subject,
    text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
    html: emailPage(
      locale,
      `<p>${escapeHtml(t.lead)}</p><p>${escapeHtml(t.body)}</p><p style="color:#666">${escapeHtml(t.action)}</p>`,
    ),
  };
}
