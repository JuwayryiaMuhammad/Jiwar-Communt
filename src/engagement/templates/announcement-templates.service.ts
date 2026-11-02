import { Injectable } from '@nestjs/common';
import type { AnnouncementTemplate } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  localized,
  namesText,
  type Localized,
} from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { EngagementAccess } from '../access';
import { BODY_MAX, TITLE_MAX } from '../announcements/announcements.service';
import { dbNow } from '../db-clock';

/** The CHECK announcement_templates_text. */
export const TEMPLATE_NAME = { min: 1, max: 80 } as const;
/** A compound keeps at most this many; the list is read whole. */
export const MAX_TEMPLATES = 200;

const TEXT = [
  { name: 'title', max: TITLE_MAX },
  { name: 'body', max: BODY_MAX },
] as const;

export interface TemplateInput {
  name?: string;
  titleEn?: string | null;
  bodyEn?: string | null;
  titleAr?: string | null;
  bodyAr?: string | null;
}

export const templateNotFound = () =>
  appError.notFound(
    ErrorCode.ANNOUNCEMENT_TEMPLATE_NOT_FOUND,
    'Template not found',
  );

const textOf = (t: AnnouncementTemplate): Localized => ({
  titleEn: t.titleEn,
  bodyEn: t.bodyEn,
  titleAr: t.titleAr,
  bodyAr: t.bodyAr,
});

/**
 * The compound's announcement templates (ADR 0080, `community.publish`): a
 * name and the words, in English, Arabic or both, which the composer copies
 * into a new draft. Nothing points back at a template, so it is changed and
 * deleted freely. Its name is the compound's own, once (DUPLICATE_RESOURCE
 * on `name`). Audited by name and as "changed" for the words: staff's text
 * stays out of the trail.
 */
@Injectable()
export class AnnouncementTemplatesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: EngagementAccess,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<AnnouncementTemplate[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.announcementTemplate.findMany({
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: MAX_TEMPLATES,
      }),
    );
  }

  create(
    input: TemplateInput & { name: string },
  ): Promise<AnnouncementTemplate> {
    const text = localized(input, TEXT);
    const name = input.name.trim();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const now = await dbNow(tx);
      const template = await tx.announcementTemplate.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          name,
          titleEn: text.titleEn,
          bodyEn: text.bodyEn,
          titleAr: text.titleAr,
          bodyAr: text.bodyAr,
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'announcement_template.created',
        targetId: template.id,
        metadata: { name },
      });
      return template;
    });
  }

  update(id: string, input: TemplateInput): Promise<AnnouncementTemplate> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const text = namesText(input, TEXT)
        ? localized(input, TEXT, textOf(before))
        : textOf(before);
      const name = input.name?.trim() ?? before.name;
      const after = await tx.announcementTemplate.update({
        where: { id },
        data: {
          name,
          titleEn: text.titleEn,
          bodyEn: text.bodyEn,
          titleAr: text.titleAr,
          bodyAr: text.bodyAr,
        },
      });
      const wordsChanged = Object.entries(textOf(after)).some(
        ([k, v]) => textOf(before)[k] !== v,
      );
      if (name !== before.name || wordsChanged)
        await this.audit.record(tx, {
          action: 'announcement_template.changed',
          targetId: id,
          changes: {
            ...(name !== before.name
              ? { name: { from: before.name, to: name } }
              : {}),
            ...(wordsChanged ? { words: { changed: true } } : {}),
          },
        });
      return after;
    });
  }

  delete(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      await tx.announcementTemplate.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'announcement_template.deleted',
        targetId: id,
        metadata: { name: before.name },
      });
    });
  }

  private async locked(
    tx: TenantTxClient,
    id: string,
  ): Promise<AnnouncementTemplate> {
    await tx.$queryRaw`SELECT id FROM announcement_templates WHERE id = ${id}::uuid FOR UPDATE`;
    const t = await tx.announcementTemplate.findUnique({ where: { id } });
    if (!t) throw templateNotFound();
    return t;
  }
}
