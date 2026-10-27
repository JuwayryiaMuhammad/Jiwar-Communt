import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ResidentRegistration } from '@prisma/client';
import { IdentifierHasher } from '../../core/auth/identifier';
import type { Locale } from '../../core/common/i18n/locale';
import type { Env } from '../../core/config/env.schema';
import { GlobalDbService } from '../../core/database/global-db.service';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { EmailTemplates } from '../../core/mail/email-templates';
import {
  emailPage,
  escapeHtml,
  rtlText,
  type RenderedEmail,
} from '../../core/mail/layout';
import { Outbox } from '../../core/mail/outbox';
import { dbNow } from '../db-clock';

// ============================================================================
// A registrant's status link (ADR 0062)
// ============================================================================
//
// A registrant has no account; the link emailed to them is how they follow
// their request, upload its documents and answer a correction. Its token is
// derived from the request and the link's number (HMAC with the identifier
// pepper), and the email that carries it is rendered at send time from those
// ids: no outbox row, log, audit entry or idempotency body ever holds it.
// The global pointer keeps an HMAC of the token, one per request: a new
// email (the request sent again, a correction asked) makes a new number, and
// the older link stops working. The decision deletes the pointer, so the
// link is dead once the request is decided or expires.

export const REGISTRATION_STATUS_EMAILS = {
  /** The request was received: follow it, add its documents. */
  received: 'community.registration_received',
  /** The management asks for a correction: what, and the link. */
  correction: 'community.registration_correction',
} as const;
type StatusEmail =
  (typeof REGISTRATION_STATUS_EMAILS)[keyof typeof REGISTRATION_STATUS_EMAILS];

/** The registrant's status page: `<PUBLIC_APP_URL>/rs#<token>` (`/r` is the registration form), the fragment never logged. */
const PAGE = 'rs';
const TOKEN = /^[0-9a-f]{64}$/;

/** Whether a string has the shape of a status link token (checked before any read). */
export function isRegistrationStatusToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value);
}

type Request = Pick<
  ResidentRegistration,
  'id' | 'tenantId' | 'statusLinkSeq' | 'email' | 'preferredLocale' | 'unitCode'
>;

@Injectable()
export class RegistrationStatusLinks implements OnModuleInit {
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly hasher: IdentifierHasher,
    private readonly globalDb: GlobalDbService,
    private readonly outbox: Outbox,
    private readonly templates: EmailTemplates,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  onModuleInit(): void {
    // About the request itself, like the other registration notices: the
    // registrant has no inbox, so each email is its only record.
    for (const key of Object.values(REGISTRATION_STATUS_EMAILS))
      this.templates.register(key, (locale, p) => this.render(key, locale, p), {
        category: 'account_security',
        critical: false,
        soleRecord: true,
      });
  }

  /** The pointer's key for a token. */
  pointerOf(token: string): string {
    return this.hasher.hashRegistrationStatusLink(token);
  }

  /**
   * A new link for the request, emailed now; the one before stops working.
   * The caller holds the request's row lock (FOR UPDATE) and the request is
   * undecided.
   */
  async issue(
    tx: TenantTxClient,
    reg: Request,
    email: StatusEmail,
    params: { compoundName: string; codes?: readonly string[] },
  ): Promise<void> {
    const seq = reg.statusLinkSeq + 1;
    const token = this.hasher.registrationStatusToken(
      reg.tenantId,
      reg.id,
      seq,
    );
    await tx.residentRegistration.update({
      where: { id: reg.id },
      data: { statusLinkSeq: seq },
    });
    const links = this.globalDb.in(tx).registrationStatusLink;
    await links.deleteMany({
      where: { tenantId: reg.tenantId, registrationId: reg.id },
    });
    await links.create({
      data: {
        tokenHash: this.pointerOf(token),
        tenantId: reg.tenantId,
        registrationId: reg.id,
        seq,
        createdAt: await dbNow(tx),
      },
    });
    await this.outbox.enqueue(tx, {
      tenantId: reg.tenantId,
      templateKey: email,
      locale: reg.preferredLocale,
      recipient: reg.email!,
      // Ids and codes: the link is derived from them when the email is sent.
      params: {
        compoundName: params.compoundName,
        unitCode: reg.unitCode,
        tenantId: reg.tenantId,
        registrationId: reg.id,
        seq,
        ...(params.codes ? { codes: [...params.codes] } : {}),
      },
      recipientAccountId: null,
    });
  }

  /** The decision: the link is dead from now on. */
  async revoke(tx: TenantTxClient, reg: Pick<Request, 'id' | 'tenantId'>) {
    await this.globalDb.in(tx).registrationStatusLink.deleteMany({
      where: { tenantId: reg.tenantId, registrationId: reg.id },
    });
  }

  private link(tenantId: string, registrationId: string, seq: number): string {
    const token = this.hasher.registrationStatusToken(
      tenantId,
      registrationId,
      seq,
    );
    return `${this.appUrl.replace(/\/+$/, '')}/${PAGE}#${token}`;
  }

  private render(
    key: StatusEmail,
    locale: Locale,
    p: Record<string, unknown>,
  ): RenderedEmail {
    const compound = String(p.compoundName);
    const unit = String(p.unitCode);
    const link = this.link(
      String(p.tenantId),
      String(p.registrationId),
      Number(p.seq),
    );
    const codes = Array.isArray(p.codes) ? p.codes.map(String) : [];
    const t = TEXTS[locale](compound, unit)[
      key === REGISTRATION_STATUS_EMAILS.received ? 'received' : 'correction'
    ];
    const asked = codes.map((c) => CORRECTION_LABELS[locale][c] ?? c);
    const lines = [
      t.lead,
      ...asked.map((a) => `- ${a}`),
      '',
      t.action,
      link,
      '',
      t.help,
    ];
    return {
      subject: t.subject,
      text: locale === 'ar' ? rtlText(lines) : lines.join('\n'),
      html: emailPage(
        locale,
        `<p>${escapeHtml(t.lead)}</p>${
          asked.length
            ? `<ul>${asked.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
            : ''
        }<p>${escapeHtml(t.action)}</p><p dir="ltr"><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p><p style="color:#666">${escapeHtml(t.help)}</p>`,
      ),
    };
  }
}

const CORRECTION_LABELS: Record<Locale, Record<string, string>> = {
  ar: {
    document_unreadable: 'مستند غير واضح أو لا يُقرأ',
    document_missing: 'مستند ناقص: أرفق ما يثبت صفتك في الوحدة',
    document_mismatch: 'المستند لا يطابق الوحدة أو البيانات المكتوبة',
    details_mismatch:
      'البيانات المكتوبة لا تطابق المستندات: سجّل من جديد بالبيانات الصحيحة',
  },
  en: {
    document_unreadable: 'A document cannot be read',
    document_missing:
      'A document is missing: attach proof of your capacity in the unit',
    document_mismatch: 'A document does not match the unit or your details',
    details_mismatch:
      'Your details do not match the documents: register again with the right details',
  },
};

const TEXTS: Record<
  Locale,
  (
    compound: string,
    unit: string,
  ) => Record<
    'received' | 'correction',
    { subject: string; lead: string; action: string; help: string }
  >
> = {
  ar: (compound, unit) => ({
    received: {
      subject: 'وصل طلب تسجيلك على جوار',
      lead: `وصل طلب تسجيلك في الوحدة ${unit} في ${compound}، وستراجعه الإدارة.`,
      action:
        'تابع حالة طلبك وأرفق ما يثبت صفتك في الوحدة (عقد أو مستند ملكية) من هذا الرابط:',
      help: 'الرابط خاص بك فلا تشاركه. يتوقف عن العمل عند البت في الطلب.',
    },
    correction: {
      subject: 'تطلب الإدارة تصحيح طلب تسجيلك على جوار',
      lead: `طلبت إدارة ${compound} تصحيح طلب تسجيلك في الوحدة ${unit}:`,
      action: 'صحّح الطلب وأعد إرساله من هذا الرابط:',
      help: 'الرابط خاص بك فلا تشاركه. الروابط السابقة لم تعد تعمل.',
    },
  }),
  en: (compound, unit) => ({
    received: {
      subject: 'Your Jiwar registration request was received',
      lead: `Your registration request for unit ${unit} in ${compound} was received; the management will review it.`,
      action:
        'Follow your request and attach proof of your capacity in the unit (a contract or an ownership document) here:',
      help: 'This link is yours alone: do not share it. It stops working once the request is decided.',
    },
    correction: {
      subject: 'The management asks you to correct your Jiwar registration',
      lead: `The management of ${compound} asks you to correct your registration request for unit ${unit}:`,
      action: 'Correct the request and send it again here:',
      help: 'This link is yours alone: do not share it. Earlier links no longer work.',
    },
  }),
};
