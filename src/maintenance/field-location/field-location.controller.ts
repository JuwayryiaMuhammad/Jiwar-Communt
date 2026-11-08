import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { FieldLocationService } from './field-location.service';
import {
  MyFieldLocationView,
  TechnicianLastLocationView,
} from './views/field-location.views';

/** A technician's consent to their location at three steps (ADR 0090). */
@ApiArea('technician')
@RequirePermissions('tickets.work')
@Controller('technician/location-consent')
export class TechnicianLocationController {
  constructor(private readonly locations: FieldLocationService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get my location consent',
    description:
      'Whether I consent, and my own points of the 30 days: where I was on the way, at the door and starting the work.',
  })
  @ApiOkResponse({ type: MyFieldLocationView })
  async mine(): Promise<MyFieldLocationView> {
    return MyFieldLocationView.from(await this.locations.mine());
  }

  @Post()
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Consent to my location at three steps',
    description:
      'On the way, at the door and starting the work, a point goes with the step when the app sends one; never in between. Kept 30 days; never shown to the residents. Consenting again answers the same.',
  })
  @ApiOkResponse({ type: MyFieldLocationView })
  async grant(): Promise<MyFieldLocationView> {
    return MyFieldLocationView.from(await this.locations.grant());
  }

  @Delete()
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke my location consent',
    description:
      'No point is taken any more, and every point taken goes with it. With none to revoke, nothing changes.',
  })
  @ApiOkResponse({ type: MyFieldLocationView })
  async revoke(): Promise<MyFieldLocationView> {
    return MyFieldLocationView.from(await this.locations.revoke());
  }
}

/** A technician's last known location, one at a time (ADR 0090). */
@ApiArea('field-team')
@RequireAnyPermission('field_team.manage', 'tickets.dispatch')
@Controller('staff/field-team/technicians')
export class StaffTechnicianLocationController {
  constructor(private readonly locations: FieldLocationService) {}

  @Get(':id/location')
  @NoStore()
  @ApiOperation({
    summary: "Get a technician's last known location",
    description:
      'Their latest point of the 30 days, taken on the way, at the door or starting the work, with their consent. Each read is audited: who looked, never where.',
  })
  @ApiOkResponse({ type: TechnicianLastLocationView })
  async last(
    @Param('id', parseId()) id: string,
  ): Promise<TechnicianLastLocationView> {
    return TechnicianLastLocationView.from(await this.locations.last(id));
  }
}
