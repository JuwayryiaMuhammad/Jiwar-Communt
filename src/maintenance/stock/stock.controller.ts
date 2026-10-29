import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
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
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  AdjustStockDto,
  CreateStockItemDto,
  CreateStoreDto,
  PartRequestsQueryDto,
  ReceiveStockDto,
  RequestPartDto,
  ReservePartDto,
  ReturnPartDto,
  StockCatalogueQueryDto,
  StockItemsQueryDto,
  StockMovementsQueryDto,
  TransferStockDto,
  UpdateStockItemDto,
  UpdateStoreDto,
} from './dto/stock.dto';
import { PartRequestsService } from './part-requests.service';
import { StockItemsService } from './stock-items.service';
import { StoresService } from './stores.service';
import {
  CatalogueItemView,
  PartRequestView,
  StockItemCardView,
  StockItemView,
  StockMovementView,
  StoreView,
  TicketPartsView,
} from './views/stock.views';

/** The maintenance store's stores (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('stock.manage')
@Controller('maintenance/stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  @ApiOperation({ summary: 'List the stores, oldest first' })
  @ApiOkResponse({ type: ListOf(StoreView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<StoreView>> {
    return toList(await this.stores.list(q), (s) => StoreView.from(s));
  }

  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Add a store' })
  @ApiCreatedResponse({ type: StoreView })
  async create(@Body() dto: CreateStoreDto): Promise<StoreView> {
    return StoreView.from(await this.stores.create(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a store' })
  @ApiOkResponse({ type: StoreView })
  async get(@Param('id', parseId()) id: string): Promise<StoreView> {
    return StoreView.from(await this.stores.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or retire a store' })
  @ApiOkResponse({ type: StoreView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateStoreDto,
  ): Promise<StoreView> {
    return StoreView.from(await this.stores.update(id, dto));
  }
}

/** The store's items, their stock and its movements (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('stock.manage')
@Controller('maintenance/stock')
export class StockController {
  constructor(private readonly items: StockItemsService) {}

  @Get('items')
  @ApiOperation({ summary: 'List the items with what is held, oldest first' })
  @ApiOkResponse({ type: ListOf(StockItemView) })
  async list(
    @Query() q: StockItemsQueryDto,
  ): Promise<ListResponse<StockItemView>> {
    return toList(await this.items.list(q), (i) => StockItemView.from(i));
  }

  @Post('items')
  @Idempotent()
  @ApiOperation({ summary: 'Add an item' })
  @ApiCreatedResponse({ type: StockItemCardView })
  async create(@Body() dto: CreateStockItemDto): Promise<StockItemCardView> {
    return StockItemCardView.fromCard(await this.items.create(dto));
  }

  @Get('items/:id')
  @ApiOperation({ summary: 'Get an item with each store’s level' })
  @ApiOkResponse({ type: StockItemCardView })
  async card(@Param('id', parseId()) id: string): Promise<StockItemCardView> {
    return StockItemCardView.fromCard(await this.items.card(id));
  }

  @Patch('items/:id')
  @ApiOperation({ summary: 'Rename an item, set its reorder level, retire it' })
  @ApiOkResponse({ type: StockItemCardView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateStockItemDto,
  ): Promise<StockItemCardView> {
    return StockItemCardView.fromCard(await this.items.update(id, dto));
  }

  @Post('items/:id/receive')
  @Idempotent()
  @ApiOperation({ summary: 'Receive the item into a store, at its cost' })
  @ApiCreatedResponse({ type: StockMovementView })
  async receive(
    @Param('id', parseId()) id: string,
    @Body() dto: ReceiveStockDto,
  ): Promise<StockMovementView> {
    return StockMovementView.from(await this.items.receive(id, dto));
  }

  /** `reasonCode` from the closed list `stockAdjust`. */
  @Post('items/:id/adjust')
  @Idempotent()
  @ApiOperation({ summary: 'Set a store’s level right, up or down' })
  @ApiCreatedResponse({ type: StockMovementView })
  async adjust(
    @Param('id', parseId()) id: string,
    @Body() dto: AdjustStockDto,
  ): Promise<StockMovementView> {
    return StockMovementView.from(await this.items.adjust(id, dto));
  }

  @Post('items/:id/transfer')
  @Idempotent()
  @ApiOperation({ summary: 'Move the item from one store to another' })
  @ApiCreatedResponse({
    type: StockMovementView,
    description: 'The movement out; its pair in shares `transferId`.',
  })
  async transfer(
    @Param('id', parseId()) id: string,
    @Body() dto: TransferStockDto,
  ): Promise<StockMovementView> {
    return StockMovementView.from(await this.items.transfer(id, dto));
  }

  @Get('movements')
  @ApiOperation({ summary: 'List movements, newest first' })
  @ApiOkResponse({ type: ListOf(StockMovementView) })
  async movements(
    @Query() q: StockMovementsQueryDto,
  ): Promise<ListResponse<StockMovementView>> {
    return toList(await this.items.movements(q), (m) =>
      StockMovementView.from(m),
    );
  }
}

/** The store's queue of part requests (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('stock.manage')
@Controller('maintenance/part-requests')
export class PartRequestsController {
  constructor(private readonly requests: PartRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'List part requests, oldest first' })
  @ApiOkResponse({ type: ListOf(PartRequestView) })
  async queue(
    @Query() q: PartRequestsQueryDto,
  ): Promise<ListResponse<PartRequestView>> {
    return toList(await this.requests.queue(q), (r) => PartRequestView.from(r));
  }

  @Post(':id/reserve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hold the part in a store for the ticket' })
  @ApiOkResponse({ type: PartRequestView })
  async reserve(
    @Param('id', parseId()) id: string,
    @Body() dto: ReservePartDto,
  ): Promise<PartRequestView> {
    return PartRequestView.from(await this.requests.reserve(id, dto.storeId));
  }

  @Post(':id/issue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hand the reserved part over to the technician' })
  @ApiOkResponse({ type: PartRequestView })
  async issue(@Param('id', parseId()) id: string): Promise<PartRequestView> {
    return PartRequestView.from(await this.requests.issue(id));
  }

  /** `reasonCode` from the closed list `partRequestDecline`. */
  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a part request' })
  @ApiOkResponse({ type: PartRequestView })
  async decline(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<PartRequestView> {
    return PartRequestView.from(
      await this.requests.decline(id, dto.reasonCode),
    );
  }
}

/** A ticket's parts, for dispatch and the store (ADR 0065). */
@ApiArea('maintenance')
@RequireAnyPermission('tickets.dispatch', 'stock.manage')
@Controller('maintenance/tickets/:id/parts')
export class DispatchTicketPartsController {
  constructor(private readonly requests: PartRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'Get a ticket’s part requests and what it got' })
  @ApiOkResponse({ type: TicketPartsView })
  async get(@Param('id', parseId()) id: string): Promise<TicketPartsView> {
    return TicketPartsView.from(await this.requests.ofTicket(id, 'dispatch'));
  }
}

/** The technician's parts: the catalogue, requests, returns (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('tickets.work')
@Controller('technician')
export class TechnicianPartsController {
  constructor(
    private readonly items: StockItemsService,
    private readonly requests: PartRequestsService,
  ) {}

  @Get('stock/items')
  @ApiOperation({ summary: 'Find an item to ask for' })
  @ApiOkResponse({ type: ListOf(CatalogueItemView) })
  async catalogue(
    @Query() q: StockCatalogueQueryDto,
  ): Promise<ListResponse<CatalogueItemView>> {
    return toList(await this.items.catalogue(q), (c) =>
      CatalogueItemView.from(c),
    );
  }

  @Get('tickets/:id/parts')
  @ApiOperation({ summary: 'Get my ticket’s part requests and what it got' })
  @ApiOkResponse({ type: TicketPartsView })
  async parts(@Param('id', parseId()) id: string): Promise<TicketPartsView> {
    return TicketPartsView.from(await this.requests.ofTicket(id, 'technician'));
  }

  /** While the work is in hand. */
  @Post('tickets/:id/part-requests')
  @Idempotent()
  @ApiOperation({ summary: 'Ask the store for a part' })
  @ApiCreatedResponse({ type: PartRequestView })
  async request(
    @Param('id', parseId()) id: string,
    @Body() dto: RequestPartDto,
  ): Promise<PartRequestView> {
    return PartRequestView.from(await this.requests.request(id, dto));
  }

  /** `reasonCode` from the closed list `partRequestCancel`. */
  @Post('part-requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Call off a part request before it is issued' })
  @ApiOkResponse({ type: PartRequestView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<PartRequestView> {
    return PartRequestView.from(await this.requests.cancel(id, dto.reasonCode));
  }

  /** Never more than the ticket got of the item, net of returns. */
  @Post('tickets/:id/part-returns')
  @Idempotent()
  @ApiOperation({ summary: 'Return an unused part to a store' })
  @ApiCreatedResponse({ type: StockMovementView })
  async returnPart(
    @Param('id', parseId()) id: string,
    @Body() dto: ReturnPartDto,
  ): Promise<StockMovementView> {
    return StockMovementView.from(await this.requests.returnPart(id, dto));
  }
}
