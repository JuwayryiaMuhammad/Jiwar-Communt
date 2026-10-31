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
  ApiNoContentResponse,
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
import {
  CreateGroupOfferDto,
  GroupOfferReasonDto,
  GroupOfferUnitDto,
  JoinGroupOfferDto,
  StaffGroupOffersQueryDto,
} from './dto/group-offers.dto';
import { GroupOffersService } from './group-offers.service';
import { GroupOfferView } from './views/group-offer.views';

/** Residents' group offers, on the market (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('market/group-offers')
export class GroupOffersController {
  constructor(private readonly offers: GroupOffersService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the group offers in interest, open or confirmed',
  })
  @ApiOkResponse({ type: ListOf(GroupOfferView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<GroupOfferView>> {
    return toList(await this.offers.list(q), (r) => GroupOfferView.from(r));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a group offer and my part in it' })
  @ApiOkResponse({ type: GroupOfferView })
  async get(@Param('id', parseId()) id: string): Promise<GroupOfferView> {
    return GroupOfferView.from(await this.offers.get(id));
  }

  @Post(':id/interest')
  @NoStore()
  @ApiOperation({ summary: 'Say I would join (non-binding)' })
  @ApiCreatedResponse({ type: GroupOfferView })
  async interest(
    @Param('id', parseId()) id: string,
    @Body() dto: GroupOfferUnitDto,
  ): Promise<GroupOfferView> {
    return GroupOfferView.from(await this.offers.interest(id, dto.unitId));
  }

  @Post(':id/join')
  @NoStore()
  @ApiOperation({ summary: 'Join an open group offer for one of my units' })
  @ApiCreatedResponse({ type: GroupOfferView })
  async join(
    @Param('id', parseId()) id: string,
    @Body() dto: JoinGroupOfferDto,
  ): Promise<GroupOfferView> {
    return GroupOfferView.from(
      await this.offers.join(id, dto.unitId, dto.quantity),
    );
  }

  @Post(':id/leave')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Leave a group offer I joined, while it is open' })
  @ApiOkResponse({ type: GroupOfferView })
  async leave(@Param('id', parseId()) id: string): Promise<GroupOfferView> {
    return GroupOfferView.from(await this.offers.leave(id));
  }
}

/** The market's handlers run the group offers (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.handle')
@Controller('staff/group-offers')
export class StaffGroupOffersController {
  constructor(private readonly offers: GroupOffersService) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Publish a group offer' })
  @ApiCreatedResponse({ type: GroupOfferView })
  async create(@Body() dto: CreateGroupOfferDto): Promise<GroupOfferView> {
    return GroupOfferView.from(await this.offers.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the group offers' })
  @ApiOkResponse({ type: ListOf(GroupOfferView) })
  async list(
    @Query() q: StaffGroupOffersQueryDto,
  ): Promise<ListResponse<GroupOfferView>> {
    return toList(await this.offers.staffList(q), (r) =>
      GroupOfferView.from(r),
    );
  }

  @Post(':id/open')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'End the interest phase now: open it' })
  @ApiNoContentResponse()
  async open(@Param('id', parseId()) id: string): Promise<void> {
    await this.offers.open(id);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Call a group offer off' })
  @ApiNoContentResponse()
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: GroupOfferReasonDto,
  ): Promise<void> {
    await this.offers.cancel(id, dto.reasonCode);
  }
}
