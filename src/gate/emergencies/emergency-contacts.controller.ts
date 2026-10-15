import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { EmergencyContactsService } from './emergency-contacts.service';
import { EmergencyContactsView } from './views/emergency-contacts.views';

/** A unit's emergency contacts (ADR 0047). */
@ApiArea('emergencies')
@RequirePermissions('emergencies.report')
@Controller('units/:unitId/emergency-contacts')
export class EmergencyContactsController {
  constructor(private readonly contacts: EmergencyContactsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'Get a unit’s emergency contacts',
    description:
      'For anyone the unit gives the emergency button. The family (with their phones) only for someone who lives there too.',
  })
  @ApiOkResponse({ type: EmergencyContactsView })
  async get(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<EmergencyContactsView> {
    return EmergencyContactsView.from(await this.contacts.forUnit(unitId));
  }
}
