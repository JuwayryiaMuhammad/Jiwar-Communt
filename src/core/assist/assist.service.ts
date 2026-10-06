import { Injectable } from '@nestjs/common';
import {
  AccountDeletionService,
  type DeletionRequestView,
} from '../accounts/account-deletion.service';
import { ACCOUNT_EMAILS } from '../accounts/account-emails';
import { appError, ErrorCode } from '../common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../common/reasons';
import {
  checkCode,
  ConsentsService,
  type ConsentState,
} from '../consents/consents.service';
import { GlobalDbService } from '../database/global-db.service';
import { TenantTx, type TenantTxClient } from '../database/tenant-tx.service';
import {
  DataExportsService,
  type DataExportRead,
} from '../exports/data-exports.service';
import { Outbox } from '../mail/outbox';
import { Notifier } from '../notifications/notifier';
import {
  checkUpdate,
  NotificationPreferencesService,
  type PreferencesRead,
  type PreferencesUpdate,
} from '../preferences/notification-preferences.service';

/** What a manager did for the account; the account is told which. */
export type AssistedAction =
  | 'notification_preferences'
  | 'consent_granted'
  | 'consent_revoked'
  | 'data_export'
  | 'deletion_requested'
  | 'deletion_cancelled';

/**
 * The assisted path (ADR 0036, `residents.assist`): a manager acts for an
 * account that does not use the app — its delivery preferences, its
 * consents, a personal-data export, a deletion request (and its undo).
 *
 * - Only for a resident or family account of this compound that is not
 *   erased; anything else is ACCOUNT_NOT_FOUND.
 * - Every action needs a reason code from a closed list (`in_person`,
 *   `phone_call`, `written_request`), is marked assisted in its own events
 *   and audit entry, and tells the account (inbox and email).
 * - An assisted export goes only to the account's own email: the manager's
 *   response never carries a link, and the manager never downloads it.
 */
@Injectable()
export class AssistService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly notifier: Notifier,
    private readonly outbox: Outbox,
    private readonly preferences: NotificationPreferencesService,
    private readonly consents: ConsentsService,
    private readonly exports: DataExportsService,
    private readonly deletion: AccountDeletionService,
  ) {}

  async preferencesOf(accountId: string): Promise<PreferencesRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      return this.preferences.read(tx, accountId, new Date());
    });
  }

  async updatePreferences(
    accountId: string,
    input: PreferencesUpdate,
    reasonCode: string | undefined,
  ): Promise<PreferencesRead> {
    const reason = assistReason(reasonCode);
    checkUpdate(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      const read = await this.preferences.apply(
        tx,
        accountId,
        input,
        { reasonCode: reason },
        new Date(),
      );
      await this.tell(tx, accountId, 'notification_preferences', reason);
      return read;
    });
  }

  async consentsOf(accountId: string): Promise<ConsentState[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      return this.consents.states(tx, accountId);
    });
  }

  async grantConsent(
    accountId: string,
    code: string,
    version: number,
    reasonCode: string | undefined,
  ): Promise<ConsentState> {
    const reason = assistReason(reasonCode);
    const known = checkCode(code);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      const state = await this.consents.change(
        tx,
        accountId,
        known,
        'grant',
        version,
        { reasonCode: reason },
      );
      await this.tell(tx, accountId, 'consent_granted', reason);
      return state;
    });
  }

  async revokeConsent(
    accountId: string,
    code: string,
    reasonCode: string | undefined,
  ): Promise<ConsentState> {
    const reason = assistReason(reasonCode);
    const known = checkCode(code);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      const state = await this.consents.change(
        tx,
        accountId,
        known,
        'revoke',
        null,
        { reasonCode: reason },
      );
      await this.tell(tx, accountId, 'consent_revoked', reason);
      return state;
    });
  }

  /** The archive goes only to the account's own email (ACCOUNT_HAS_NO_EMAIL). */
  async requestExport(
    accountId: string,
    reasonCode: string | undefined,
  ): Promise<DataExportRead> {
    const reason = assistReason(reasonCode);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      const filed = await this.exports.file(
        tx,
        accountId,
        { reasonCode: reason },
        new Date(),
      );
      await this.tell(tx, accountId, 'data_export', reason);
      return filed;
    });
  }

  async requestDeletion(
    accountId: string,
    reasonCode: string | undefined,
  ): Promise<DeletionRequestView> {
    const reason = assistReason(reasonCode);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      const filed = await this.deletion.fileRequest(
        tx,
        accountId,
        { reasonCode: reason },
        new Date(),
      );
      await this.tell(tx, accountId, 'deletion_requested', reason);
      return filed;
    });
  }

  /** The undo of a deletion filed by mistake (ADR 0036). */
  async cancelDeletion(
    accountId: string,
    reasonCode: string | undefined,
  ): Promise<void> {
    const reason = assistReason(reasonCode);
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.target(tx, accountId);
      await this.deletion.cancelIn(
        tx,
        accountId,
        { reasonCode: reason },
        new Date(),
      );
      await this.tell(tx, accountId, 'deletion_cancelled', reason);
    });
  }

  /** A resident or family account of this compound, not erased. */
  private async target(tx: TenantTxClient, accountId: string): Promise<void> {
    const account = await tx.account.findUnique({
      where: { id: accountId },
      select: { type: true, status: true },
    });
    if (
      !account ||
      account.status === 'erased' ||
      (account.type !== 'resident' && account.type !== 'family')
    ) {
      throw appError.notFound(ErrorCode.ACCOUNT_NOT_FOUND, 'Account not found');
    }
  }

  /** Never silent: the account learns what was done for it, and how asked. */
  private async tell(
    tx: TenantTxClient,
    accountId: string,
    action: AssistedAction,
    reason: string,
  ): Promise<void> {
    await this.notifier.notify(tx, [accountId], {
      kind: 'account.assisted_action',
      params: { action, reason },
      targetId: accountId,
    });
    const account = await tx.account.findUniqueOrThrow({
      where: { id: accountId },
      select: { email: true, preferredLocale: true, tenantId: true },
    });
    if (!account.email) return;
    const tenant = await this.globalDb.in(tx).tenant.findUniqueOrThrow({
      where: { id: account.tenantId },
      select: { name: true },
    });
    await this.outbox.enqueue(tx, {
      tenantId: account.tenantId,
      templateKey: ACCOUNT_EMAILS.assistedAction,
      locale: account.preferredLocale,
      recipient: account.email,
      params: { compoundName: tenant.name, action, reason },
      recipientAccountId: accountId,
    });
  }
}

/** One of `in_person`, `phone_call`, `written_request` (REASON_REQUIRED). */
function assistReason(code: string | undefined): string {
  return requireReasonCodeOnly(code, REASON_CODES.assist);
}
