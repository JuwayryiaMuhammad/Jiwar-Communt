import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CancelIncidentActionDto,
  CreateIncidentActionDto,
  IncidentActionDoneDto,
  UpdateIncidentActionDto,
} from './dto/incident-actions.dto';
import { IncidentActionsService } from './incident-actions.service';
import {
  IncidentActionView,
  OwnIncidentActionView,
} from './views/incident-action.views';

/** Corrective actions, the keepers' side (ADR 0087): `incidents.manage`. */
@ApiArea('incidents')
@RequirePermissions('incidents.manage')
@Controller('staff/security')
export class StaffIncidentActionsController {
  constructor(private readonly actions: IncidentActionsService) {}

  @Get('incidents/:id/actions')
  @NoStore()
  @ApiOperation({
    summary: 'List an incident’s corrective actions',
    description: 'In the order they were made.',
  })
  @ApiOkResponse({ type: ListOf(IncidentActionView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<IncidentActionView>> {
    return bounded(await this.actions.list(id), (r) =>
      IncidentActionView.from(r),
    );
  }

  @Post('incidents/:id/actions')
  @NoStore()
  @ApiOperation({
    summary: 'Add a corrective action to an incident',
    description:
      'Not to a closed incident (INCIDENT_CLOSED). Its owner is told. The incident does not close while it is open (INCIDENT_ACTIONS_OPEN).',
  })
  @ApiCreatedResponse({ type: IncidentActionView })
  async create(
    @Param('id', parseId()) id: string,
    @Body() dto: CreateIncidentActionDto,
  ): Promise<IncidentActionView> {
    return IncidentActionView.from(await this.actions.create(id, dto));
  }

  @Patch('incident-actions/:actionId')
  @NoStore()
  @ApiOperation({
    summary: 'Change a corrective action',
    description: 'While open: its words, owner and day; a new owner is told.',
  })
  @ApiOkResponse({ type: IncidentActionView })
  async update(
    @Param('actionId', parseId('actionId')) id: string,
    @Body() dto: UpdateIncidentActionDto,
  ): Promise<IncidentActionView> {
    return IncidentActionView.from(await this.actions.update(id, dto));
  }

  @Post('incident-actions/:actionId/done')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Mark a corrective action done' })
  @ApiOkResponse({ type: IncidentActionView })
  async done(
    @Param('actionId', parseId('actionId')) id: string,
    @Body() dto: IncidentActionDoneDto,
  ): Promise<IncidentActionView> {
    return IncidentActionView.from(await this.actions.done(id, dto, 'manage'));
  }

  /** `reasonCode` from the closed list `incidentActionCancel`. */
  @Post('incident-actions/:actionId/cancel')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Call a corrective action off' })
  @ApiOkResponse({ type: IncidentActionView })
  async cancel(
    @Param('actionId', parseId('actionId')) id: string,
    @Body() dto: CancelIncidentActionDto,
  ): Promise<IncidentActionView> {
    return IncidentActionView.from(
      await this.actions.cancel(id, dto.reasonCode),
    );
  }
}

/**
 * An owner's own corrective actions (ADR 0087): any staff member or the
 * manager given one, with no permission; another's is not found.
 */
@ApiArea('incidents')
@Controller('staff/incident-actions')
export class OwnIncidentActionsController {
  constructor(private readonly actions: IncidentActionsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'My open corrective actions, by due day' })
  @ApiOkResponse({ type: ListOf(OwnIncidentActionView) })
  async mine(): Promise<ListResponse<OwnIncidentActionView>> {
    return bounded(await this.actions.mine(), (r) =>
      OwnIncidentActionView.from(r),
    );
  }

  @Post(':actionId/done')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Mark my corrective action done' })
  @ApiOkResponse({ type: IncidentActionView })
  async done(
    @Param('actionId', parseId('actionId')) id: string,
    @Body() dto: IncidentActionDoneDto,
  ): Promise<IncidentActionView> {
    return IncidentActionView.from(await this.actions.done(id, dto, 'owner'));
  }
}
