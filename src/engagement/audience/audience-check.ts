import { Injectable } from '@nestjs/common';
import { CommunityEngagementPort, type Audience } from '../../community';
import { FieldErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { invalid } from '../../core/common/localized';
import { EVERYONE } from './audience';

/**
 * An audience as the staff named it, checked: every building is one the
 * compound's units name now (INVALID_VALUE on `audience.buildings.<i>`).
 * Absent: the whole compound, everyone.
 */
@Injectable()
export class AudienceCheck {
  constructor(private readonly community: CommunityEngagementPort) {}

  async check(
    tx: TenantTxClient,
    input:
      | {
          buildings?: string[] | null;
          occupancy: Audience['occupancy'];
          unitIds?: string[] | null;
        }
      | undefined,
  ): Promise<Audience> {
    if (!input) return EVERYONE;
    if (input.unitIds?.length) return this.units(tx, input);
    if (!input.buildings?.length)
      return { buildings: null, occupancy: input.occupancy };
    const known = new Set(await this.community.buildings(tx));
    const unknown = input.buildings.flatMap((b, i) =>
      known.has(b)
        ? []
        : [
            {
              field: `audience.buildings.${i}`,
              code: FieldErrorCode.INVALID_VALUE,
            },
          ],
    );
    if (unknown.length) throw invalid(unknown);
    return {
      buildings: [...new Set(input.buildings)],
      occupancy: input.occupancy,
    };
  }

  /**
   * An audience of single units (ADR 0080): never beside buildings
   * (FIELD_NOT_ALLOWED on `audience.unitIds`), each one of the compound's
   * units (INVALID_VALUE on `audience.unitIds.<i>`).
   */
  private async units(
    tx: TenantTxClient,
    input: {
      buildings?: string[] | null;
      occupancy: Audience['occupancy'];
      unitIds?: string[] | null;
    },
  ): Promise<Audience> {
    const ids = input.unitIds ?? [];
    if (input.buildings?.length)
      throw invalid([
        { field: 'audience.unitIds', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    const known = await this.community.knownUnits(tx, ids);
    const unknown = ids.flatMap((id, i) =>
      known.has(id)
        ? []
        : [
            {
              field: `audience.unitIds.${i}`,
              code: FieldErrorCode.INVALID_VALUE,
            },
          ],
    );
    if (unknown.length) throw invalid(unknown);
    return {
      buildings: null,
      occupancy: input.occupancy,
      units: [...new Set(ids)].sort(),
    };
  }

  /** How many units and accounts an audience is, right now. */
  async size(
    tx: TenantTxClient,
    audience: Audience,
  ): Promise<{ units: number; accounts: number }> {
    const members = await this.community.members(tx, audience);
    return {
      units: new Set(members.map((m) => m.unitId)).size,
      accounts: new Set(members.map((m) => m.accountId)).size,
    };
  }

  buildings(tx: TenantTxClient): Promise<string[]> {
    return this.community.buildings(tx);
  }
}
