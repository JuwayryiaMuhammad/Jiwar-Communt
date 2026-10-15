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
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequireAnyPermission } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  AcceptEmergencyDto,
  ResolveEmergencyDto,
  StaffEmergenciesQueryDto,
} from './dto/emergencies.dto';
import { EmergencyRespondersService } from './emergency-responders.service';
import { StaffEmergencyView } from './views/staff-emergency.views';

/**
 * Emergencies, the responders' side (ADR 0047): a guard inside an open
 * shift (`gate.operate`), an `emergencies.respond` holder, and the
 * management (`emergencies.manage`, also the dashboard's live view).
 */
@ApiArea('emergencies')
@RequireAnyPermission(
  'gate.operate',
  'emergencies.respond',
  'emergencies.manage',
)
@Controller('gate/emergencies')
export class EmergencyRespondersController {
  constructor(
    private readonly responders: EmergencyRespondersService,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the compound’s emergencies',
    description:
      '`status=open` is the queue, oldest first. A guard needs an open shift (NO_OPEN_SHIFT).',
  })
  @ApiOkResponse({ type: ListOf(StaffEmergencyView) })
  async list(
    @Query() q: StaffEmergenciesQueryDto,
  ): Promise<ListResponse<StaffEmergencyView>> {
    const me = this.ctx.accountId;
    return toList(await this.responders.list(q), (r) =>
      StaffEmergencyView.from(r, me),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get an emergency' })
  @ApiOkResponse({ type: StaffEmergencyView })
  async get(@Param('id', parseId()) id: string): Promise<StaffEmergencyView> {
    return StaffEmergencyView.from(
      await this.responders.get(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Accept an emergency, with the minutes you expect to take',
    description:
      'The first one wins (409 EMERGENCY_ALREADY_ACCEPTED for the others). The household is told, and sees your first name and your gate’s phone.',
  })
  @ApiOkResponse({ type: StaffEmergencyView })
  async accept(
    @Param('id', parseId()) id: string,
    @Body() dto: AcceptEmergencyDto,
  ): Promise<StaffEmergencyView> {
    return StaffEmergencyView.from(
      await this.responders.accept(id, dto.etaMinutes),
      this.ctx.accountId,
    );
  }

  @Post(':id/arrived')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({ summary: 'Mark that you arrived (its responder)' })
  @ApiOkResponse({ type: StaffEmergencyView })
  async arrived(
    @Param('id', parseId()) id: string,
  ): Promise<StaffEmergencyView> {
    return StaffEmergencyView.from(
      await this.responders.arrived(id),
      this.ctx.accountId,
    );
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Resolve an emergency',
    description: 'Its responder, or the management (`emergencies.manage`).',
  })
  @ApiOkResponse({ type: StaffEmergencyView })
  async resolve(
    @Param('id', parseId()) id: string,
    @Body() dto: ResolveEmergencyDto,
  ): Promise<StaffEmergencyView> {
    return StaffEmergencyView.from(
      await this.responders.resolve(id, dto),
      this.ctx.accountId,
    );
  }
}
