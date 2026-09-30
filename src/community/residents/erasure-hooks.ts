import { Injectable, type OnModuleInit } from '@nestjs/common';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { HouseholdsService } from '../households/households.service';
import { WorkersService } from '../workers/workers.service';
import { ResidentsService } from './residents.service';

/**
 * The community side of an erasure (ADR 0023), inside core's transaction:
 * occupancies end (a primary's unit goes under review), memberships end,
 * and the workers the account registered are ended with a notice and a
 * `settle_before_close` obligation — payroll must settle before the
 * worker's file closes (11 §7). Delegations end through the deactivation
 * hook when a membership leaves the account inactive, and here otherwise.
 */
@Injectable()
export class ErasureHooks implements OnModuleInit {
  constructor(
    private readonly lifecycle: AccountLifecycle,
    private readonly residents: ResidentsService,
    private readonly households: HouseholdsService,
    private readonly workers: WorkersService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.onErasing(async (tx, account) => {
      const after = [
        ...(await this.residents.endAllOccupanciesOf(tx, account.id)),
        ...(await this.households.removeAllForAccount(tx, account.id)),
      ];
      await this.workers.endAllRequestedBy(tx, account.id);
      after.push(...(await this.lifecycle.deactivated(tx, account)));
      return after;
    });
  }
}
