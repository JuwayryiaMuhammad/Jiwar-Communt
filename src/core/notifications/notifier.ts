import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { newId } from '../common/uuid';
import type { TenantTxClient } from '../database/tenant-tx.service';
import {
  checkNotification,
  PERSONAL_PARAMS,
  type NotificationKind,
  type NotificationParams,
} from './kinds';

export interface NotificationInput {
  kind: NotificationKind;
  params: NotificationParams;
  /** The id of the catalog target (a request, an engagement…). */
  targetId: string;
}

/**
 * Writes inbox rows (ADR 0027) in the caller's transaction, so a
 * notification exists exactly when the action that caused it committed.
 * The priority and target type come from the catalog, never the caller.
 * Push and SMS will read this table later; nothing is sent from here.
 */
@Injectable()
export class Notifier {
  constructor(private readonly cls: ClsService<AppClsStore>) {}

  async notify(
    tx: TenantTxClient,
    accountIds: readonly string[],
    input: NotificationInput,
  ): Promise<number> {
    const spec = checkNotification(input.kind, input.params);
    const tenantId = this.cls.isActive()
      ? this.cls.get('txTenantId')
      : undefined;
    if (!tenantId)
      throw new Error('Notifier.notify must run inside a TenantTx transaction');
    const recipients = [...new Set(accountIds)];
    if (!recipients.length) return 0;
    const { count } = await tx.notification.createMany({
      data: recipients.map((accountId) => ({
        id: newId(),
        tenantId,
        accountId,
        kind: input.kind,
        priority: spec.priority,
        params: input.params,
        targetType: spec.target,
        targetId: input.targetId,
      })),
    });
    return count;
  }

  /**
   * Removes the personal params (names) from every notification about these
   * targets, read or not: the data they came from has expired.
   */
  async scrubPersonal(
    tx: TenantTxClient,
    targetIds: readonly string[],
  ): Promise<number> {
    if (!targetIds.length) return 0;
    const keys = [...PERSONAL_PARAMS];
    return tx.$executeRaw`
      UPDATE notifications
         SET params = params - ${keys}::text[]
       WHERE target_id = ANY(${[...targetIds]}::uuid[])
         AND params ?| ${keys}::text[]`;
  }
}
