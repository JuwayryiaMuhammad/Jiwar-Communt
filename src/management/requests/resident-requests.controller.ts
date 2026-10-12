import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
import { CreateRequestDto, ResidentRequestsQueryDto } from './dto/requests.dto';
import { RequestsService } from './requests.service';
import { RequestCreatedView, ResidentRequestView } from './views/request.views';

/**
 * A resident's requests to the management (ADR 0039): their own, and only
 * their own. Every answer here is no-store.
 */
@ApiArea('management-requests')
@RequirePermissions('requests.create')
@Controller('management-requests')
export class ResidentRequestsController {
  constructor(private readonly requests: RequestsService) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Open a request to the management' })
  @Idempotent()
  @ApiCreatedResponse({ type: RequestCreatedView })
  async create(@Body() dto: CreateRequestDto): Promise<RequestCreatedView> {
    return RequestCreatedView.from(await this.requests.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my requests to the management' })
  @ApiOkResponse({ type: ListOf(ResidentRequestView) })
  async list(
    @Query() q: ResidentRequestsQueryDto,
  ): Promise<ListResponse<ResidentRequestView>> {
    return toList(await this.requests.listMine(q), (r) =>
      ResidentRequestView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one of my requests to the management' })
  @ApiOkResponse({ type: ResidentRequestView })
  async get(@Param('id', parseId()) id: string): Promise<ResidentRequestView> {
    return ResidentRequestView.from(await this.requests.detail(id, 'resident'));
  }
}
