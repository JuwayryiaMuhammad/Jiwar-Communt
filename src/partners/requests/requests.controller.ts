import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreatePartnerRequestDto,
  MyPartnerRequestsQueryDto,
  ResidentCancelPartnerRequestDto,
} from './dto/requests.dto';
import { PartnerRequestsService } from './requests.service';
import { ResidentPartnerRequestView } from './views/request.views';

/** A resident's requests to the compound's partners (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.request')
@Controller('partner-requests')
export class PartnerRequestsController {
  constructor(private readonly requests: PartnerRequestsService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({ summary: 'Ask a partner for a service at a unit' })
  @ApiCreatedResponse({ type: ResidentPartnerRequestView })
  async create(
    @Body() dto: CreatePartnerRequestDto,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(await this.requests.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List my requests to partners, newest activity first',
  })
  @ApiOkResponse({ type: ListOf(ResidentPartnerRequestView) })
  async mine(
    @Query() q: MyPartnerRequestsQueryDto,
  ): Promise<ListResponse<ResidentPartnerRequestView>> {
    return toList(await this.requests.mine(q), (r) =>
      ResidentPartnerRequestView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my requests, with its history' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(await this.requests.get(id));
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Cancel my request' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ResidentCancelPartnerRequestDto,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(
      await this.requests.cancel(id, dto.reasonCode),
    );
  }

  @Post(':id/accept-proposal')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Take the window the partner proposed' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async acceptProposal(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(
      await this.requests.acceptProposal(id),
    );
  }

  @Post(':id/decline-proposal')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Decline the window the partner proposed' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async declineProposal(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(
      await this.requests.declineProposal(id),
    );
  }

  @Post(':id/done')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Say the service was given' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async done(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(await this.requests.done(id));
  }

  @Post(':id/no-show')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Say the partner did not come' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async noShow(
    @Param('id', parseId()) id: string,
  ): Promise<ResidentPartnerRequestView> {
    return ResidentPartnerRequestView.from(await this.requests.noShow(id));
  }
}
