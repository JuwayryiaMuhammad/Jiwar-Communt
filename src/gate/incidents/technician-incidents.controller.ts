import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { TechnicianIncidentDto } from './dto/incidents.dto';
import { IncidentsService } from './incidents.service';
import { GuardIncidentView } from './views/incident.views';

/** A technician's incident from the ticket in their hands (ADR 0067). */
@ApiArea('incidents')
@RequirePermissions('tickets.work')
@Controller('technician/tickets/:id/incidents')
export class TechnicianIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Report an injury, a near miss or a hazard from your ticket',
    description:
      'With no shift: where is the ticket’s — its unit, or the ticket itself. TICKET_NOT_FOUND unless the ticket is in your hands. The incidents’ keepers are told; a critical one is a critical push.',
  })
  @ApiCreatedResponse({ type: GuardIncidentView })
  async report(
    @Param('id', parseId()) id: string,
    @Body() dto: TechnicianIncidentDto,
  ): Promise<GuardIncidentView> {
    return GuardIncidentView.from(
      await this.incidents.report({ ...dto, ticketId: id }, 'technician'),
    );
  }
}
