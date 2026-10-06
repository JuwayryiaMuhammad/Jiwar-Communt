import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Notification } from '@prisma/client';
import { AccountRecord } from '../accounts/account-record';
import { DeletionRequestResponse, MeView } from '../accounts/views/me.views';
import { ConsentsService } from '../consents/consents.service';
import { ConsentView } from '../consents/views/consent.views';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx } from '../database/tenant-tx.service';
import { NotificationView } from '../notifications/views/notification.views';
import { NotificationPreferencesService } from '../preferences/notification-preferences.service';
import { PreferencesView } from '../preferences/views/preferences.views';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from './export-sections';

/** A file's extension in the archive, from its stored type. */
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

/** Notifications per archive entry. */
const INBOX_PAGE = 500;

/**
 * The core's sections of a personal-data export (ADR 0036), each through
 * the account's own view:
 * - `account.json`: `GET /me` (the document masked, no birth date), without
 *   the photo URL — the photo itself is under `files/`;
 * - `notification-preferences.json`, `consents.json` (the current state and
 *   the account's own history: who acted is `self`, `assisted` or
 *   `system`, never a manager's id);
 * - `sessions.json`: `GET /me/sessions` plus ended ones, never an IP;
 * - `notifications/NNN.json`: the inbox as `GET /me/notifications` shows it;
 * - `deletion-requests.json`;
 * - `files/`: the account's own photo and the ready files it owns.
 */
@Injectable()
export class CoreExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly preferences: NotificationPreferencesService,
    private readonly consents: ConsentsService,
  ) {}

  onModuleInit(): void {
    this.sections.register('account', (s) => this.account(s));
    this.sections.register('preferences', () => this.preferencesOf());
    this.sections.register('consents', (s) => this.consentsOf(s));
    this.sections.register('sessions', (s) => this.sessions(s));
    this.sections.register('notifications', (s) => this.inbox(s));
    this.sections.register('deletion_requests', (s) => this.deletions(s));
    this.sections.register('files', (s) => this.ownFiles(s));
  }

  private async *account(s: ExportSubject): AsyncIterable<ExportEntry> {
    const account = await this.tenantTx.withTenantTx((tx) =>
      tx.account.findUniqueOrThrow({ where: { id: s.accountId } }),
    );
    yield {
      path: 'account.json',
      json: MeView.from(AccountRecord.from(account), null),
    };
  }

  private async *preferencesOf(): AsyncIterable<ExportEntry> {
    yield {
      path: 'notification-preferences.json',
      json: PreferencesView.from(await this.preferences.mine()),
    };
  }

  private async *consentsOf(s: ExportSubject): AsyncIterable<ExportEntry> {
    const current = await this.consents.mine();
    const events = await this.tenantTx.withTenantTx((tx) =>
      tx.consentEvent.findMany({
        where: { accountId: s.accountId },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    yield {
      path: 'consents.json',
      json: {
        current: current.map((c) => ConsentView.from(c)),
        history: events.map((e) => ({
          code: e.code,
          version: e.version,
          action: e.action,
          by:
            e.actorType === 'system'
              ? 'system'
              : e.assisted
                ? 'assisted'
                : 'self',
          reasonCode: e.assistReasonCode,
          occurredAt: e.occurredAt,
        })),
      },
    };
  }

  private async *sessions(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.globalDb.session.findMany({
      where: { accountId: s.accountId, tenantId: s.tenantId },
      select: {
        id: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        revokedAt: true,
        userAgent: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    yield { path: 'sessions.json', json: rows };
  }

  private async *inbox(s: ExportSubject): AsyncIterable<ExportEntry> {
    let cursor: { createdAt: Date; id: string } | null = null;
    for (let page = 1; ; page++) {
      const after: { createdAt: Date; id: string } | null = cursor;
      const rows: Notification[] = await this.tenantTx.withTenantTx((tx) =>
        tx.notification.findMany({
          where: {
            accountId: s.accountId,
            ...(after
              ? {
                  OR: [
                    { createdAt: { gt: after.createdAt } },
                    { createdAt: after.createdAt, id: { gt: after.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: INBOX_PAGE,
        }),
      );
      if (!rows.length) return;
      yield {
        path: `notifications/${String(page).padStart(3, '0')}.json`,
        json: rows.map((n) =>
          NotificationView.from({
            id: n.id,
            kind: n.kind,
            priority: n.priority,
            params: n.params as Record<string, string | number>,
            targetType: n.targetType,
            targetId: n.targetId,
            readAt: n.readAt,
            createdAt: n.createdAt,
          }),
        ),
      };
      if (rows.length < INBOX_PAGE) return;
      const last = rows[rows.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
  }

  private async *deletions(s: ExportSubject): AsyncIterable<ExportEntry> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      tx.accountDeletionRequest.findMany({
        where: { accountId: s.accountId },
        orderBy: { requestedAt: 'asc' },
      }),
    );
    yield {
      path: 'deletion-requests.json',
      json: rows.map((r) => DeletionRequestResponse.from(r)),
    };
  }

  private async *ownFiles(s: ExportSubject): AsyncIterable<ExportEntry> {
    const { photo, owned } = await this.tenantTx.withTenantTx(async (tx) => {
      const account = await tx.account.findUniqueOrThrow({
        where: { id: s.accountId },
        select: { photoFileId: true },
      });
      const photo = account.photoFileId
        ? await tx.storedFile.findFirst({
            where: {
              id: account.photoFileId,
              status: 'ready',
              deletedAt: null,
            },
            select: { id: true, contentType: true },
          })
        : null;
      const owned = await tx.storedFile.findMany({
        where: {
          ownerAccountId: s.accountId,
          status: 'ready',
          deletedAt: null,
          purpose: { not: 'data_export' },
        },
        select: { id: true, contentType: true },
        orderBy: { createdAt: 'asc' },
      });
      return { photo, owned };
    });
    if (photo)
      yield {
        path: `files/photo.${EXTENSIONS[photo.contentType] ?? 'bin'}`,
        fileId: photo.id,
      };
    for (const f of owned)
      yield {
        path: `files/${f.id}.${EXTENSIONS[f.contentType] ?? 'bin'}`,
        fileId: f.id,
      };
  }
}
