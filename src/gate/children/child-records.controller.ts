import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ChildRecordsService } from './child-records.service';
import {
  ChildAlertsQueryDto,
  ChildPickupsQueryDto,
} from './dto/child-records.dto';
import { ChildAlertView, ChildPickupView } from './views/child-record.views';

/** A unit's children's exits (ADR 0054), for the household adults. */
@ApiArea('children')
@RequirePermissions('household.manage')
@Controller('units/:unitId/children/pickups')
export class ChildPickupsController {
  constructor(private readonly records: ChildRecordsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: "List the children's exits",
    description:
      'For the people who live in the unit: each exit recorded at the gate in the last 30 days (who took the child, or alone, or refused), newest first.',
  })
  @ApiOkResponse({ type: ListOf(ChildPickupView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: ChildPickupsQueryDto,
  ): Promise<ListResponse<ChildPickupView>> {
    return toList(
      await this.records.forHousehold(unitId, {
        memberId: q.memberId,
        cursor: q.cursor,
        limit: q.limit,
      }),
      (v) => v,
    );
  }
}

/**
 * Unauthorized pickups (ADR 0054), for the roster's keepers who were
 * alerted: never the child, never a plain exit.
 */
@ApiArea('children')
@RequirePermissions('guard_roster.manage')
@Controller('staff/security/child-alerts')
export class ChildAlertsController {
  constructor(private readonly records: ChildRecordsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the unauthorized child pickups',
    description:
      'The last 30 days, newest first: when, where, which guard, which unit, how the person was known.',
  })
  @ApiOkResponse({ type: ListOf(ChildAlertView) })
  async list(
    @Query() q: ChildAlertsQueryDto,
  ): Promise<ListResponse<ChildAlertView>> {
    return toList(
      await this.records.alerts({ cursor: q.cursor, limit: q.limit }),
      (v) => v,
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Read an unauthorized child pickup' })
  @ApiOkResponse({ type: ChildAlertView })
  get(@Param('id', parseId()) id: string): Promise<ChildAlertView> {
    return this.records.alert(id);
  }
}
