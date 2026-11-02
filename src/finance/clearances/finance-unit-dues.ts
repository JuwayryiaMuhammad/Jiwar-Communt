import { Injectable, type OnModuleInit } from '@nestjs/common';
import { UnitDues } from '../../core/unit-dues/unit-dues';
import { FinanceAccess } from '../access';
import { ZERO } from '../money';
import { owedByUnit } from './clearances.service';

/**
 * What a unit owes, for community's moves and ownership transfers (ADR
 * 0083): the clearance's own computation (owedByUnit), and for a decision
 * the lock the clearance takes — the compound's shared, then the unit's —
 * so a payment or an invoice landing while the dues gate reads waits for
 * it, or was counted.
 */
@Injectable()
export class FinanceUnitDues implements OnModuleInit {
  constructor(
    private readonly dues: UnitDues,
    private readonly access: FinanceAccess,
  ) {}

  onModuleInit(): void {
    this.dues.register({
      owed: async (tx, unitIds) => {
        const owed = await owedByUnit(tx, unitIds);
        return new Map(
          unitIds.map((id) => [id, (owed.get(id) ?? ZERO).toFixed(2)]),
        );
      },
      lockAndRead: async (tx, unitId) => {
        await this.access.lockUnits(tx, [unitId]);
        return ((await owedByUnit(tx, [unitId])).get(unitId) ?? ZERO).toFixed(
          2,
        );
      },
    });
  }
}
