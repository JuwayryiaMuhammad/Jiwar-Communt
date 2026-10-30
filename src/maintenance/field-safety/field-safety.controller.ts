import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  AcknowledgeDto,
  HazardsDto,
  PermitsQueryDto,
  PublishInstructionDto,
  RequestPermitDto,
} from './dto/field-safety.dto';
import { WorkHazardsService } from './hazards.service';
import { SafetyInstructionsService } from './safety-instructions.service';
import {
  HazardsView,
  SafetyAcknowledgementView,
  SafetyInstructionView,
  TicketPermitsView,
  TicketSafetyView,
  WorkPermitView,
} from './views/field-safety.views';
import { WorkPermitsService } from './work-permits.service';

/** Work permits, for who decides them (ADR 0067). */
@ApiArea('maintenance')
@RequirePermissions('safety.manage')
@Controller('maintenance/work-permits')
export class WorkPermitsController {
  constructor(private readonly permits: WorkPermitsService) {}

  @Get()
  @ApiOperation({ summary: 'List the work permits, the latest asked first' })
  @ApiOkResponse({ type: ListOf(WorkPermitView) })
  async list(
    @Query() q: PermitsQueryDto,
  ): Promise<ListResponse<WorkPermitView>> {
    return toList(await this.permits.list(q), (p) => WorkPermitView.from(p));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One work permit' })
  @ApiOkResponse({ type: WorkPermitView })
  async get(@Param('id', parseId()) id: string): Promise<WorkPermitView> {
    return WorkPermitView.from(await this.permits.get(id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a requested permit before it expires' })
  @ApiOkResponse({ type: WorkPermitView })
  async approve(@Param('id', parseId()) id: string): Promise<WorkPermitView> {
    return WorkPermitView.from(await this.permits.approve(id));
  }

  /** `reasonCode` from the closed list `workPermitReject`. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a requested permit' })
  @ApiOkResponse({ type: WorkPermitView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<WorkPermitView> {
    return WorkPermitView.from(await this.permits.reject(id, dto.reasonCode));
  }

  /** `reasonCode` from the closed list `workPermitRevoke`. */
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an approved permit' })
  @ApiOkResponse({ type: WorkPermitView })
  async revoke(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<WorkPermitView> {
    return WorkPermitView.from(await this.permits.revoke(id, dto.reasonCode));
  }
}

/** A ticket's permits, on its panel (ADR 0067). */
@ApiArea('maintenance')
@RequireAnyPermission('safety.manage', 'tickets.dispatch')
@Controller('maintenance/tickets/:id/permits')
export class TicketPermitsController {
  constructor(private readonly permits: WorkPermitsService) {}

  @Get()
  @ApiOperation({ summary: 'A ticket’s hazards and its cycle’s permits' })
  @ApiOkResponse({ type: TicketPermitsView })
  async get(@Param('id', parseId()) id: string): Promise<TicketPermitsView> {
    return TicketPermitsView.from(await this.permits.ofTicket(id, 'dispatch'));
  }
}

/** The technician's safety on their own ticket (ADR 0067). */
@ApiArea('maintenance')
@RequirePermissions('tickets.work')
@Controller('technician/tickets/:id')
export class TechnicianSafetyController {
  constructor(
    private readonly permits: WorkPermitsService,
    private readonly instructions: SafetyInstructionsService,
  ) {}

  @Get('permits')
  @ApiOperation({ summary: 'My ticket’s hazards and this cycle’s permits' })
  @ApiOkResponse({ type: TicketPermitsView })
  async permitsOf(
    @Param('id', parseId()) id: string,
  ): Promise<TicketPermitsView> {
    return TicketPermitsView.from(
      await this.permits.ofTicket(id, 'technician'),
    );
  }

  @Post('permits')
  @Idempotent()
  @ApiOperation({ summary: 'Ask for a work permit for a hazard' })
  @ApiCreatedResponse({ type: WorkPermitView })
  async request(
    @Param('id', parseId()) id: string,
    @Body() dto: RequestPermitDto,
  ): Promise<WorkPermitView> {
    return WorkPermitView.from(await this.permits.request(id, dto));
  }

  @Get('safety')
  @ApiOperation({
    summary:
      'The category’s current safety instructions, and my acknowledgement',
  })
  @ApiOkResponse({ type: TicketSafetyView })
  async safety(@Param('id', parseId()) id: string): Promise<TicketSafetyView> {
    return TicketSafetyView.from(await this.instructions.forTicket(id));
  }

  @Post('safety/acknowledge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge the current safety instructions' })
  @ApiOkResponse({ type: SafetyAcknowledgementView })
  async acknowledge(
    @Param('id', parseId()) id: string,
    @Body() dto: AcknowledgeDto,
  ): Promise<SafetyAcknowledgementView> {
    return SafetyAcknowledgementView.from(
      await this.instructions.acknowledge(id, dto.instructionId),
    );
  }
}

/** What needs a permit, and a category's safety instructions (ADR 0067). */
@ApiArea('maintenance')
@Controller('maintenance/categories/:id')
export class CategorySafetyController {
  constructor(
    private readonly hazards: WorkHazardsService,
    private readonly instructions: SafetyInstructionsService,
  ) {}

  @Put('permit-hazards')
  @RequirePermissions('maintenance.manage')
  @ApiOperation({
    summary: 'Set the hazards a category’s work needs a permit for',
  })
  @ApiOkResponse({ type: HazardsView })
  async setHazards(
    @Param('id', parseId()) id: string,
    @Body() dto: HazardsDto,
  ): Promise<HazardsView> {
    return { hazards: await this.hazards.setForCategory(id, dto.hazards) };
  }

  @Get('safety-instructions')
  @RequirePermissions('safety.manage')
  @ApiOperation({
    summary: 'A category’s safety instructions, the latest version first',
  })
  @ApiOkResponse({ type: [SafetyInstructionView] })
  async versions(
    @Param('id', parseId()) id: string,
  ): Promise<SafetyInstructionView[]> {
    return (await this.instructions.versions(id)).map((i) =>
      SafetyInstructionView.from(i),
    );
  }

  @Post('safety-instructions')
  @RequirePermissions('safety.manage')
  @ApiOperation({
    summary: 'Publish the next version of a category’s safety instructions',
  })
  @ApiCreatedResponse({ type: SafetyInstructionView })
  async publish(
    @Param('id', parseId()) id: string,
    @Body() dto: PublishInstructionDto,
  ): Promise<SafetyInstructionView> {
    return SafetyInstructionView.from(await this.instructions.publish(id, dto));
  }
}

/** What work on an asset type needs a permit for (ADR 0067). */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/asset-types/:id')
export class AssetTypeHazardsController {
  constructor(private readonly hazards: WorkHazardsService) {}

  @Put('permit-hazards')
  @ApiOperation({
    summary: 'Set the hazards an asset type’s work needs a permit for',
  })
  @ApiOkResponse({ type: HazardsView })
  async setHazards(
    @Param('id', parseId()) id: string,
    @Body() dto: HazardsDto,
  ): Promise<HazardsView> {
    return { hazards: await this.hazards.setForAssetType(id, dto.hazards) };
  }
}
