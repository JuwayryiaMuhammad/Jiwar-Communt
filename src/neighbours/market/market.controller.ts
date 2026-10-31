import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
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
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ConversationsService } from '../conversations/conversations.service';
import { ConversationMessageDto } from '../conversations/dto/conversations.dto';
import { ConversationCreatedView } from '../conversations/views/conversation.views';
import {
  CloseMarketReportDto,
  CreateListingDto,
  ListingReasonDto,
  MarketReportsQueryDto,
  ReportListingDto,
  MarketQueryDto,
  MarketQueueQueryDto,
  OpenShopDto,
  ShopReasonDto,
  StaffShopsQueryDto,
  UpdateListingDto,
  UpdateMarketSettingsDto,
} from './dto/market.dto';
import { ListingsService } from './listings.service';
import { MarketReportsService } from './market-reports.service';
import { MarketSettingsService } from './market-settings.service';
import { ShopsService } from './shops.service';
import {
  ListingCreatedView,
  ListingView,
  MarketReportCreatedView,
  MarketReportView,
  MarketSettingsView,
  MyListingView,
  ShopView,
  StaffListingView,
  StaffShopView,
} from './views/market.views';

/**
 * The market, for residents (ADR 0071): listings name no seller, only the
 * building they were listed from. Every answer is no-store.
 */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('market/listings')
export class MarketController {
  constructor(private readonly listings: ListingsService) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'List something on the market' })
  @Idempotent()
  @ApiCreatedResponse({ type: ListingCreatedView })
  async create(@Body() dto: CreateListingDto): Promise<ListingCreatedView> {
    return ListingCreatedView.from(await this.listings.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Search the market' })
  @ApiOkResponse({ type: ListOf(ListingView) })
  async search(@Query() q: MarketQueryDto): Promise<ListResponse<ListingView>> {
    return toList(await this.listings.search(q), (r) => ListingView.from(r));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a listing on the market, or one of my own' })
  @ApiOkResponse({ type: ListingView })
  async get(@Param('id', parseId()) id: string): Promise<ListingView> {
    return ListingView.from(await this.listings.get(id));
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary:
      'Change my listing while it waits or is live (back to review where the compound reviews)',
  })
  @ApiOkResponse({ type: MyListingView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateListingDto,
  ): Promise<MyListingView> {
    return MyListingView.fromMine(await this.listings.update(id, dto));
  }

  @Post(':id/withdraw')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Take my listing off the market' })
  @ApiNoContentResponse()
  async withdraw(@Param('id', parseId()) id: string): Promise<void> {
    await this.listings.withdraw(id);
  }

  @Post(':id/sold')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Mark my listing sold (or given, or let)' })
  @ApiNoContentResponse()
  async sold(@Param('id', parseId()) id: string): Promise<void> {
    await this.listings.sold(id);
  }
}

/**
 * Writing to whoever listed something, about it, without either name
 * (ADR 0071): the neighbours' masked conversation, read and written
 * through `/neighbour-conversations` from then on.
 */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('market/listings')
export class ListingContactController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly reports: MarketReportsService,
  ) {}

  /** Once a listing; enough units reporting take it off for review. */
  @Post(':id/report')
  @NoStore()
  @ApiOperation({ summary: 'Report a listing to the management' })
  @ApiCreatedResponse({ type: MarketReportCreatedView })
  async report(
    @Param('id', parseId()) id: string,
    @Body() dto: ReportListingDto,
  ): Promise<MarketReportCreatedView> {
    return MarketReportCreatedView.from(await this.reports.report(id, dto));
  }

  @Post(':id/conversations')
  @NoStore()
  @ApiOperation({ summary: 'Write to whoever listed it, without either name' })
  @Idempotent()
  @ApiCreatedResponse({ type: ConversationCreatedView })
  async start(
    @Param('id', parseId()) id: string,
    @Body() dto: ConversationMessageDto,
  ): Promise<ConversationCreatedView> {
    return ConversationCreatedView.from(
      await this.conversations.startOnListing(id, dto),
    );
  }
}

/** A resident's own listings, every state (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('me/market/listings')
export class MyListingsController {
  constructor(private readonly listings: ListingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my listings and how each ended' })
  @ApiOkResponse({ type: ListOf(MyListingView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<MyListingView>> {
    return toList(await this.listings.listMine(q), (r) =>
      MyListingView.fromMine(r),
    );
  }
}

/** The handlers' review of the market (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.handle')
@Controller('market/review')
export class MarketReviewController {
  constructor(private readonly listings: ListingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List listings waiting for review or reported' })
  @ApiOkResponse({ type: ListOf(StaffListingView) })
  async queue(
    @Query() q: MarketQueueQueryDto,
  ): Promise<ListResponse<StaffListingView>> {
    return toList(await this.listings.queue(q), (r) =>
      StaffListingView.fromStaff(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get any listing of the compound' })
  @ApiOkResponse({ type: StaffListingView })
  async get(@Param('id', parseId()) id: string): Promise<StaffListingView> {
    return StaffListingView.fromStaff(await this.listings.staffGet(id));
  }

  @Post(':id/approve')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Let a waiting listing on the market, or a reported one back',
  })
  @ApiNoContentResponse()
  async approve(@Param('id', parseId()) id: string): Promise<void> {
    await this.listings.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Turn a waiting listing down' })
  @ApiNoContentResponse()
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ListingReasonDto,
  ): Promise<void> {
    await this.listings.reject(id, dto.reasonCode);
  }

  @Post(':id/remove')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Take a live or reported listing off the market' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', parseId()) id: string,
    @Body() dto: ListingReasonDto,
  ): Promise<void> {
    await this.listings.remove(id, dto.reasonCode);
  }
}

/** The market's settings (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.handle')
@Controller('market/settings')
export class MarketSettingsController {
  constructor(private readonly settings: MarketSettingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get the market’s settings' })
  @ApiOkResponse({ type: MarketSettingsView })
  async get(): Promise<MarketSettingsView> {
    return MarketSettingsView.from(await this.settings.get());
  }

  @Patch()
  @NoStore()
  @ApiOperation({ summary: 'Change the market’s settings' })
  @ApiOkResponse({ type: MarketSettingsView })
  async update(
    @Body() dto: UpdateMarketSettingsDto,
  ): Promise<MarketSettingsView> {
    return MarketSettingsView.from(await this.settings.update(dto));
  }
}

/** Residents' small shops (ADR 0071): a building, never a person. */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('market/shops')
export class ShopsController {
  constructor(private readonly shops: ShopsService) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Open my shop (it waits for the management)' })
  @ApiCreatedResponse({ type: ShopView })
  async open(@Body() dto: OpenShopDto): Promise<ShopView> {
    const shop = await this.shops.open(dto);
    return ShopView.from(await this.shops.get(shop.id));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the open shops' })
  @ApiOkResponse({ type: ListOf(ShopView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<ShopView>> {
    return toList(await this.shops.list(q), (r) => ShopView.from(r));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get an open shop, or my own' })
  @ApiOkResponse({ type: ShopView })
  async get(@Param('id', parseId()) id: string): Promise<ShopView> {
    return ShopView.from(await this.shops.get(id));
  }
}

/** A resident's own shop (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.post')
@Controller('me/market/shop')
export class MyShopController {
  constructor(private readonly shops: ShopsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get my shop, open or the last I had' })
  @ApiOkResponse({ type: ShopView })
  async get(): Promise<ShopView> {
    return ShopView.from(await this.shops.mine());
  }

  @Post('close')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Close my shop' })
  @ApiNoContentResponse()
  async close(): Promise<void> {
    await this.shops.close();
  }
}

/** The handlers' review of the shops (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.handle')
@Controller('market/shop-review')
export class ShopReviewController {
  constructor(private readonly shops: ShopsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the shops, by state' })
  @ApiOkResponse({ type: ListOf(StaffShopView) })
  async list(
    @Query() q: StaffShopsQueryDto,
  ): Promise<ListResponse<StaffShopView>> {
    return toList(await this.shops.staffList(q), (r) =>
      StaffShopView.fromStaff(r),
    );
  }

  @Post(':id/approve')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({
    summary: 'Open a waiting shop, or reinstate a suspended one',
  })
  @ApiNoContentResponse()
  async approve(@Param('id', parseId()) id: string): Promise<void> {
    await this.shops.approve(id);
  }

  @Post(':id/reject')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Turn a waiting shop down' })
  @ApiNoContentResponse()
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ShopReasonDto,
  ): Promise<void> {
    await this.shops.reject(id, dto.reasonCode);
  }

  @Post(':id/suspend')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Suspend an open shop' })
  @ApiNoContentResponse()
  async suspend(
    @Param('id', parseId()) id: string,
    @Body() dto: ShopReasonDto,
  ): Promise<void> {
    await this.shops.suspend(id, dto.reasonCode);
  }
}

/** The handlers' queue of reported listings (ADR 0071). */
@ApiArea('market')
@RequirePermissions('market.handle')
@Controller('market/reports')
export class MarketReportsController {
  constructor(private readonly reports: MarketReportsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the reports of listings' })
  @ApiOkResponse({ type: ListOf(MarketReportView) })
  async list(
    @Query() q: MarketReportsQueryDto,
  ): Promise<ListResponse<MarketReportView>> {
    return toList(await this.reports.list(q), (r) => MarketReportView.from(r));
  }

  @Post(':id/close')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Close a report with an outcome' })
  @ApiNoContentResponse()
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: CloseMarketReportDto,
  ): Promise<void> {
    await this.reports.close(id, dto.reasonCode);
  }
}
