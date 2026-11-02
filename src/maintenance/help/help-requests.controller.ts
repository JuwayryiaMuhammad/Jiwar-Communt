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
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  HelpRequestsQueryDto,
  RequestHelpDto,
  TakeHelpDto,
} from './dto/help-requests.dto';
import { HelpRequestsService } from './help-requests.service';
import { HelpRequestView } from './views/help-request.views';

/** A technician's calls for help (ADR 0078): `tickets.work`. */
@ApiArea('field-team')
@RequirePermissions('tickets.work')
@Controller('maintenance/help-requests')
export class TechnicianHelpController {
  constructor(private readonly help: HelpRequestsService) {}

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Call for help',
    description:
      'More hands, someone who knows the fault, parts, or a second person for safety, about one of my tickets or none. One live call at a time (409 TECHNICIAN_HELP_LIVE). The field team is told at once; the managers if nobody takes it in fifteen minutes.',
  })
  @ApiCreatedResponse({ type: HelpRequestView })
  request(@Body() dto: RequestHelpDto): Promise<HelpRequestView> {
    return this.help.request(dto);
  }

  @Get('mine')
  @NoStore()
  @ApiOperation({
    summary: 'List my calls for help',
    description: 'Mine and those I was sent to help, newest first.',
  })
  @ApiOkResponse({ type: ListOf(HelpRequestView) })
  async mine(): Promise<ListResponse<HelpRequestView>> {
    return bounded(await this.help.mine(), (r) => r);
  }

  @Post(':id/resolve')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a call for help resolved',
    description:
      'Mine or one I was sent to help, once taken (409 TECHNICIAN_HELP_CLOSED otherwise).',
  })
  @ApiOkResponse({ type: HelpRequestView })
  resolve(@Param('id', parseId()) id: string): Promise<HelpRequestView> {
    return this.help.resolve(id, 'technician');
  }

  @Post(':id/cancel')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Call off my call for help',
    description: 'While open or taken.',
  })
  @ApiOkResponse({ type: HelpRequestView })
  cancel(@Param('id', parseId()) id: string): Promise<HelpRequestView> {
    return this.help.cancel(id);
  }
}

/** The technicians' calls for help, as the field team handles them (ADR 0078). */
@ApiArea('field-team')
@RequirePermissions('field_team.manage')
@Controller('staff/field-team/help-requests')
export class StaffHelpController {
  constructor(private readonly help: HelpRequestsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the calls for help',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(HelpRequestView) })
  async list(
    @Query() q: HelpRequestsQueryDto,
  ): Promise<ListResponse<HelpRequestView>> {
    return bounded(await this.help.list(q), (r) => r);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a call for help' })
  @ApiOkResponse({ type: HelpRequestView })
  get(@Param('id', parseId()) id: string): Promise<HelpRequestView> {
    return this.help.get(id);
  }

  @Post(':id/take')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a call for help',
    description:
      'Once, while open (409 TECHNICIAN_HELP_CLOSED): sending another technician or none. The caller and the helper are told.',
  })
  @ApiOkResponse({ type: HelpRequestView })
  take(
    @Param('id', parseId()) id: string,
    @Body() dto: TakeHelpDto,
  ): Promise<HelpRequestView> {
    return this.help.take(id, dto.helperId);
  }

  @Post(':id/resolve')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a call for help resolved',
    description: 'Once taken (409 TECHNICIAN_HELP_CLOSED otherwise).',
  })
  @ApiOkResponse({ type: HelpRequestView })
  resolve(@Param('id', parseId()) id: string): Promise<HelpRequestView> {
    return this.help.resolve(id, 'field_team');
  }
}
