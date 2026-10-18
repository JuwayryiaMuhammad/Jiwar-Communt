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
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReportIncidentDto } from './dto/incidents.dto';
import { IncidentsService } from './incidents.service';
import { GuardIncidentView } from './views/incident.views';

/** Incidents, the guard's side (ADR 0053): `gate.operate`, on shift. */
@ApiArea('incidents')
@RequirePermissions('gate.operate')
@Controller('gate/incidents')
export class GateIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Report an incident',
    description:
      'Inside a shift, at a gate or in a zone: what happened, how bad, where (a place and/or a unit), when, your words and up to five photos, and what it links to. The incidents’ keepers are told; a critical one is a critical push.',
  })
  @ApiCreatedResponse({ type: GuardIncidentView })
  async report(@Body() dto: ReportIncidentDto): Promise<GuardIncidentView> {
    return GuardIncidentView.from(await this.incidents.report(dto, 'guard'));
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The incidents I reported',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(GuardIncidentView) })
  async mine(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<GuardIncidentView>> {
    return toList(await this.incidents.mine(q), (r) =>
      GuardIncidentView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'An incident I reported',
    description: 'Another’s is not found.',
  })
  @ApiOkResponse({ type: GuardIncidentView })
  async own(@Param('id', parseId()) id: string): Promise<GuardIncidentView> {
    return GuardIncidentView.from(await this.incidents.own(id));
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Acknowledge an incident I reported',
    description: 'Once; again answers the same.',
  })
  @ApiOkResponse({ type: GuardIncidentView })
  async acknowledge(
    @Param('id', parseId()) id: string,
  ): Promise<GuardIncidentView> {
    return GuardIncidentView.from(
      await this.incidents.acknowledge(id, 'author', 'guard'),
    );
  }
}
