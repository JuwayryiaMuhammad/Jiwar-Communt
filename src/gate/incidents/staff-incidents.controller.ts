import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
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
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  AcknowledgeIncidentDto,
  AssignIncidentDto,
  CloseIncidentDto,
  IncidentNoteDto,
  ReportIncidentDto,
  StaffIncidentsQueryDto,
} from './dto/incidents.dto';
import { IncidentsService } from './incidents.service';
import {
  IncidentInvestigatorView,
  StaffIncidentView,
} from './views/incident.views';

/** Incidents, the management's side (ADR 0053): `incidents.manage`. */
@ApiArea('incidents')
@RequirePermissions('incidents.manage')
@Controller('staff/security/incidents')
export class StaffIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Report an incident from the office',
    description: 'As a guard does, with no shift.',
  })
  @ApiCreatedResponse({ type: StaffIncidentView })
  async report(@Body() dto: ReportIncidentDto): Promise<StaffIncidentView> {
    return StaffIncidentView.from(await this.incidents.report(dto, 'staff'));
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the incidents',
    description:
      'Newest first; by status, type, severity and when they happened.',
  })
  @ApiOkResponse({ type: ListOf(StaffIncidentView) })
  async list(
    @Query() q: StaffIncidentsQueryDto,
  ): Promise<ListResponse<StaffIncidentView>> {
    return toList(await this.incidents.list(q), (r) =>
      StaffIncidentView.from(r),
    );
  }

  @Get('investigators')
  @NoStore()
  @ApiOperation({
    summary: 'List who may investigate an incident',
    description: 'Active accounts holding `incidents.manage`, by name.',
  })
  @ApiOkResponse({ type: ListOf(IncidentInvestigatorView) })
  async investigators(): Promise<ListResponse<IncidentInvestigatorView>> {
    return bounded(await this.incidents.investigators(), (a) => a);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get an incident' })
  @ApiOkResponse({ type: StaffIncidentView })
  async get(@Param('id', parseId()) id: string): Promise<StaffIncidentView> {
    return StaffIncidentView.from(await this.incidents.get(id));
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Assign an investigator',
    description:
      'An active holder of `incidents.manage` (INVESTIGATOR_NOT_ELIGIBLE). Open: now investigating. Closed: INCIDENT_CLOSED. The investigator is told.',
  })
  @ApiOkResponse({ type: StaffIncidentView })
  async assign(
    @Param('id', parseId()) id: string,
    @Body() dto: AssignIncidentDto,
  ): Promise<StaffIncidentView> {
    return StaffIncidentView.from(
      await this.incidents.assign(id, dto.investigatorId),
    );
  }

  @Post(':id/notes')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Write an internal note',
    description: 'The management’s only: never the author’s to read.',
  })
  @ApiOkResponse({ type: StaffIncidentView })
  async note(
    @Param('id', parseId()) id: string,
    @Body() dto: IncidentNoteDto,
  ): Promise<StaffIncidentView> {
    return StaffIncidentView.from(await this.incidents.addNote(id, dto.body));
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Acknowledge an incident',
    description:
      'As its author (one you reported), or as a reviewer (one you did not: INCIDENT_OWN otherwise). Once each; again answers the same.',
  })
  @ApiOkResponse({ type: StaffIncidentView })
  async acknowledge(
    @Param('id', parseId()) id: string,
    @Body() dto: AcknowledgeIncidentDto,
  ): Promise<StaffIncidentView> {
    return StaffIncidentView.from(
      await this.incidents.acknowledge(id, dto.role, 'staff'),
    );
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Close an incident',
    description:
      'With an outcome code (`incidentOutcome`) and a closing note of your own. Closed already: INCIDENT_CLOSED.',
  })
  @ApiOkResponse({ type: StaffIncidentView })
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: CloseIncidentDto,
  ): Promise<StaffIncidentView> {
    return StaffIncidentView.from(await this.incidents.close(id, dto));
  }
}
