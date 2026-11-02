import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { ClosedUnitsService } from './closed-units.service';
import { ClosedUnitView } from './views/closed-unit.views';

/**
 * The units in closed mode and their rounds (ADR 0083). A due round is
 * scheduled as a closed-unit inspection task with `roundId`
 * (POST /staff/security/tasks).
 */
@ApiArea('guard-duty')
@RequirePermissions('guard_tasks.manage')
@Controller('staff/security/closed-units')
export class ClosedUnitsController {
  constructor(private readonly closedUnits: ClosedUnitsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Units in closed mode, the longest closed first, with their last inspection and round',
  })
  @ApiOkResponse({ type: ListOf(ClosedUnitView) })
  async list(): Promise<ListResponse<ClosedUnitView>> {
    return bounded(await this.closedUnits.list(), (u) =>
      ClosedUnitView.from(u),
    );
  }
}
