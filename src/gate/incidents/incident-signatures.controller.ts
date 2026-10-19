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
import { SignIncidentDto } from './dto/incident-signatures.dto';
import { IncidentSignaturesService } from './incident-signatures.service';
import { IncidentSignatureView } from './views/incident-signature.views';

const SIGN = {
  summary: 'Sign the incident report',
  description:
    'A drawn signature (`incident_signature` PNG) over the SHA-256 of the report’s canonical content for the role (ADR 0056). `author`: its fields, photos, recordings and evidence; `reviewer`: that and its status, outcome and closing note. Once per role and content (INCIDENT_ALREADY_SIGNED). Never changes: after a change inside its scope it reads `superseded`, and a new one is needed.',
};

/** The reporting guard's side (ADR 0056): their own incident, on duty. */
@ApiArea('incidents')
@RequirePermissions('gate.operate')
@Controller('gate/incidents')
export class GateIncidentSignaturesController {
  constructor(private readonly signatures: IncidentSignaturesService) {}

  @Post(':id/signatures')
  @NoStore()
  @ApiOperation(SIGN)
  @ApiCreatedResponse({ type: IncidentSignatureView })
  async sign(
    @Param('id', parseId()) id: string,
    @Body() dto: SignIncidentDto,
  ): Promise<IncidentSignatureView> {
    return IncidentSignatureView.from(
      await this.signatures.sign(id, dto, 'guard'),
    );
  }

  @Get(':id/signatures')
  @NoStore()
  @ApiOperation({ summary: 'The signatures on my incident' })
  @ApiOkResponse({ type: ListOf(IncidentSignatureView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<IncidentSignatureView>> {
    return bounded(await this.signatures.list(id, 'guard'), (s) =>
      IncidentSignatureView.from(s),
    );
  }
}

/** The incidents' keepers (ADR 0056). */
@ApiArea('incidents')
@RequirePermissions('incidents.manage')
@Controller('staff/security/incidents')
export class StaffIncidentSignaturesController {
  constructor(private readonly signatures: IncidentSignaturesService) {}

  @Post(':id/signatures')
  @NoStore()
  @ApiOperation(SIGN)
  @ApiCreatedResponse({ type: IncidentSignatureView })
  async sign(
    @Param('id', parseId()) id: string,
    @Body() dto: SignIncidentDto,
  ): Promise<IncidentSignatureView> {
    return IncidentSignatureView.from(
      await this.signatures.sign(id, dto, 'staff'),
    );
  }

  @Get(':id/signatures')
  @NoStore()
  @ApiOperation({ summary: 'The signatures on an incident' })
  @ApiOkResponse({ type: ListOf(IncidentSignatureView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<IncidentSignatureView>> {
    return bounded(await this.signatures.list(id, 'staff'), (s) =>
      IncidentSignatureView.from(s),
    );
  }
}
