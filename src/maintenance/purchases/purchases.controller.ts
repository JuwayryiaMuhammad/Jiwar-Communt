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
  ApprovePurchaseRequestDto,
  CreatePurchaseRequestDto,
  FulfilPurchaseRequestDto,
  PurchaseRequestsQueryDto,
  RejectPurchaseRequestDto,
} from './dto/purchases.dto';
import { PurchasesService } from './purchases.service';
import { PurchaseRequestView } from './views/purchase.views';

/**
 * Light purchase requests (ADR 0077): asked for with `purchases.request`,
 * decided with `purchases.approve` (up to the manager's limit, above it
 * under the board's approval).
 */
@ApiArea('maintenance')
@Controller('staff/purchase-requests')
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @Get()
  @RequireAnyPermission('purchases.request', 'purchases.approve')
  @ApiOperation({
    summary: 'List purchase requests',
    description: 'Newest first; a requester sees their own.',
  })
  @ApiOkResponse({ type: ListOf(PurchaseRequestView) })
  async list(
    @Query() q: PurchaseRequestsQueryDto,
  ): Promise<ListResponse<PurchaseRequestView>> {
    return toList(await this.purchases.list(q), (r) =>
      PurchaseRequestView.from(r),
    );
  }

  @Post()
  @Idempotent()
  @RequirePermissions('purchases.request')
  @ApiOperation({ summary: 'Ask to buy something' })
  @ApiCreatedResponse({ type: PurchaseRequestView })
  async submit(
    @Body() dto: CreatePurchaseRequestDto,
  ): Promise<PurchaseRequestView> {
    return PurchaseRequestView.from(await this.purchases.submit(dto));
  }

  @Get(':id')
  @RequireAnyPermission('purchases.request', 'purchases.approve')
  @ApiOperation({ summary: 'Get a purchase request' })
  @ApiOkResponse({ type: PurchaseRequestView })
  async get(@Param('id', parseId()) id: string): Promise<PurchaseRequestView> {
    return PurchaseRequestView.from(await this.purchases.get(id));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.approve')
  @ApiOperation({ summary: 'Approve a purchase request' })
  @ApiOkResponse({ type: PurchaseRequestView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApprovePurchaseRequestDto,
  ): Promise<PurchaseRequestView> {
    return PurchaseRequestView.from(await this.purchases.approve(id, dto));
  }

  /** `reasonCode` from the closed list `purchaseReject`. */
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.approve')
  @ApiOperation({ summary: 'Turn down a purchase request' })
  @ApiOkResponse({ type: PurchaseRequestView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectPurchaseRequestDto,
  ): Promise<PurchaseRequestView> {
    return PurchaseRequestView.from(await this.purchases.reject(id, dto));
  }

  /** `reasonCode` from the closed list `purchaseCancel`; by its requester or an approver. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission('purchases.request', 'purchases.approve')
  @ApiOperation({ summary: 'Call off a purchase request' })
  @ApiOkResponse({ type: PurchaseRequestView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<PurchaseRequestView> {
    return PurchaseRequestView.from(
      await this.purchases.cancel(id, dto.reasonCode),
    );
  }

  @Post(':id/fulfil')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchases.approve')
  @ApiOperation({
    summary: 'Mark a purchase request bought',
    description: 'Once, with what paid it.',
  })
  @ApiOkResponse({ type: PurchaseRequestView })
  async fulfil(
    @Param('id', parseId()) id: string,
    @Body() dto: FulfilPurchaseRequestDto,
  ): Promise<PurchaseRequestView> {
    return PurchaseRequestView.from(
      await this.purchases.fulfil(id, dto.reference),
    );
  }
}
