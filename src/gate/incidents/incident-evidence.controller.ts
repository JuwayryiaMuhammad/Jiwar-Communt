import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
import { LinkEvidenceDto } from './dto/incident-evidence.dto';
import { IncidentEvidenceService } from './incident-evidence.service';
import { IncidentEvidenceView } from './views/incident-evidence.views';

const LINK = {
  summary: 'Keep a visitor’s photo at entry with the incident',
  description:
    'Kept for as long as the incident, instead of 30 days after the entry. Not on a closed incident (INCIDENT_CLOSED); once each (INCIDENT_EVIDENCE_EXISTS); ten at most (INCIDENT_EVIDENCE_LIMIT). Never removed.',
};

/** The reporting guard's side (ADR 0056): their own incident, on duty. */
@ApiArea('incidents')
@RequirePermissions('gate.operate')
@Controller('gate/incidents')
export class GateIncidentEvidenceController {
  constructor(private readonly evidence: IncidentEvidenceService) {}

  @Post(':id/evidence')
  @NoStore()
  @ApiOperation(LINK)
  @ApiCreatedResponse({ type: IncidentEvidenceView })
  async link(
    @Param('id', parseId()) id: string,
    @Body() dto: LinkEvidenceDto,
  ): Promise<IncidentEvidenceView> {
    return IncidentEvidenceView.from(
      await this.evidence.link(id, dto, 'guard'),
    );
  }

  @Get(':id/evidence')
  @NoStore()
  @ApiOperation({ summary: 'What my incident keeps' })
  @ApiOkResponse({ type: ListOf(IncidentEvidenceView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<IncidentEvidenceView>> {
    return bounded(await this.evidence.list(id, 'guard'), (e) =>
      IncidentEvidenceView.from(e),
    );
  }
}

/** The incidents' keepers (ADR 0056). */
@ApiArea('incidents')
@RequirePermissions('incidents.manage')
@Controller('staff/security/incidents')
export class StaffIncidentEvidenceController {
  constructor(private readonly evidence: IncidentEvidenceService) {}

  @Post(':id/evidence')
  @NoStore()
  @ApiOperation(LINK)
  @ApiCreatedResponse({ type: IncidentEvidenceView })
  async link(
    @Param('id', parseId()) id: string,
    @Body() dto: LinkEvidenceDto,
  ): Promise<IncidentEvidenceView> {
    return IncidentEvidenceView.from(
      await this.evidence.link(id, dto, 'staff'),
    );
  }

  @Get(':id/evidence')
  @NoStore()
  @ApiOperation({ summary: 'What an incident keeps' })
  @ApiOkResponse({ type: ListOf(IncidentEvidenceView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<IncidentEvidenceView>> {
    return bounded(await this.evidence.list(id, 'staff'), (e) =>
      IncidentEvidenceView.from(e),
    );
  }
}
