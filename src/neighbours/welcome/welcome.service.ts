import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  AccountLifecycle,
  type HouseholdStart,
} from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { hasText, textsOf } from './welcome-template.service';

/**
 * The welcome itself (ADR 0042). When a household starts living in a unit
 * (community says so, in the transaction that made it so), its primary
 * gets one inbox notice, pushed like any other, that points at the
 * compound's welcome text. Once per household: the row's unique index on
 * the occupancy is what "once" stands on. Nothing is sent when the
 * managers turned it off or wrote nothing; no neighbour is told anything.
 */
@Injectable()
export class WelcomeService implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly notifier: Notifier,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onHouseholdStarted((tx, household) =>
      this.greet(tx, household),
    );
  }

  async greet(tx: TenantTxClient, household: HouseholdStart): Promise<void> {
    const template = await tx.neighbourWelcomeTemplate.findUnique({
      where: { tenantId: household.tenantId },
    });
    if (!template?.enabled || !hasText(textsOf(template))) return;
    const id = newId();
    const { count } = await tx.neighbourWelcome.createMany({
      data: [
        {
          id,
          tenantId: household.tenantId,
          occupancyId: household.occupancyId,
          unitId: household.unitId,
          accountId: household.accountId,
        },
      ],
      skipDuplicates: true,
    });
    if (!count) return;
    await this.audit.record(tx, {
      action: 'neighbour_welcome.sent',
      targetId: id,
      metadata: {
        unitId: household.unitId,
        occupancyId: household.occupancyId,
        accountId: household.accountId,
      },
    });
    await this.notifier.notify(tx, [household.accountId], {
      kind: 'neighbours.welcome',
      params: {},
      targetId: id,
    });
  }
}
