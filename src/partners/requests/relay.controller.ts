import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  AcceptPartnerRequestDto,
  DeclinePartnerRequestDto,
  PartnerCancelPartnerRequestDto,
  ProposePartnerRequestDto,
} from './dto/requests.dto';
import { RelayService, type RelayRead } from './relay.service';
import {
  PARTNER_REQUEST_STATUSES,
  type PartnerRequestStatus,
} from './request-rules';
import { StaffPartnerRequestView } from './views/request.views';

export class RelayQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: PARTNER_REQUEST_STATUSES,
    enumName: 'PartnerRequestStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(
    PARTNER_REQUEST_STATUSES,
    withParams({ allowed: [...PARTNER_REQUEST_STATUSES] }),
  )
  status?: PartnerRequestStatus;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  partnerId?: string;
}

const view = (r: RelayRead) =>
  StaffPartnerRequestView.fromStaff(
    r.request,
    r.consented,
    r.firstName,
    r.pass,
  );

/** The management's relay of the partners' requests (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partner-requests')
export class RelayController {
  constructor(private readonly relay: RelayService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the requests to partners, newest first' })
  @ApiOkResponse({ type: ListOf(StaffPartnerRequestView) })
  async list(
    @Query() q: RelayQueryDto,
  ): Promise<ListResponse<StaffPartnerRequestView>> {
    return toList(await this.relay.list(q), view);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a request to a partner' })
  @ApiOkResponse({ type: StaffPartnerRequestView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<StaffPartnerRequestView> {
    return view(await this.relay.get(id));
  }

  @Post(':id/accept')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Accept a request for its partner' })
  @ApiOkResponse({ type: StaffPartnerRequestView })
  async accept(
    @Param('id', parseId()) id: string,
    @Body() dto: AcceptPartnerRequestDto,
  ): Promise<StaffPartnerRequestView> {
    return view(await this.relay.act(id, 'accept', dto));
  }

  @Post(':id/decline')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Decline a request for its partner' })
  @ApiOkResponse({ type: StaffPartnerRequestView })
  async decline(
    @Param('id', parseId()) id: string,
    @Body() dto: DeclinePartnerRequestDto,
  ): Promise<StaffPartnerRequestView> {
    return view(await this.relay.act(id, 'decline', dto));
  }

  @Post(':id/propose')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Propose another window for its partner' })
  @ApiOkResponse({ type: StaffPartnerRequestView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: ProposePartnerRequestDto,
  ): Promise<StaffPartnerRequestView> {
    return view(await this.relay.act(id, 'propose', dto));
  }

  @Post(':id/done')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Mark a request done for its partner' })
  @ApiOkResponse({ type: StaffPartnerRequestView })
  async done(
    @Param('id', parseId()) id: string,
  ): Promise<StaffPartnerRequestView> {
    return view(await this.relay.act(id, 'partner_done', {}));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Cancel an accepted request for its partner' })
  @ApiOkResponse({ type: StaffPartnerRequestView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: PartnerCancelPartnerRequestDto,
  ): Promise<StaffPartnerRequestView> {
    return view(await this.relay.act(id, 'partner_cancel', dto));
  }
}
