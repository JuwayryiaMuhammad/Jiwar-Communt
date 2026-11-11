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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import {
  AccountDetailView,
  AccountListItemView,
} from '../../core/accounts/views/account.views';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import type { ErasedAccount } from '../../core/common/http/personal';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { ContractorsService } from './contractors.service';
import {
  NewContractorDto,
  OfferToVendorDto,
  OffersQueryDto,
} from './dto/contractors.dto';
import { VendorDispatchService } from './vendor-dispatch.service';
import {
  ContractorContractView,
  ContractorOfferView,
  ContractorVendorView,
  OfferTakenView,
  VendorDispatchView,
} from './views/contractor.views';

/**
 * A vendor's contractor accounts (ADR 0088), on its page in the register:
 * invited by `vendors.manage` as staff are; deactivated through
 * `PATCH /accounts/{id}/status`.
 */
@ApiArea('maintenance')
@RequirePermissions('vendors.manage')
@Controller('staff/vendors/:id/contractors')
export class VendorContractorsController {
  constructor(private readonly contractors: ContractorsService) {}

  @Get()
  @ApiOperation({ summary: 'List a vendor’s contractor accounts' })
  @ApiOkResponse({ type: ListOf(AccountListItemView) })
  async list(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<AccountListItemView | ErasedAccount>> {
    return toList(await this.contractors.list(id, q), (a) =>
      AccountListItemView.from(a),
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Invite a contractor of the vendor',
    description:
      'An account of the `contractor` kind tied to this vendor, with the `contractor` role; it signs in as staff do. A suspended vendor takes none.',
  })
  @ApiCreatedResponse({ type: AccountDetailView })
  async add(
    @Param('id', parseId()) id: string,
    @Body() dto: NewContractorDto,
  ): Promise<AccountDetailView | ErasedAccount> {
    return AccountDetailView.fromRecord(await this.contractors.add(id, dto));
  }
}

/** Dispatch offers a queued ticket to a vendor, and takes the offer back (ADR 0088). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets/:id')
export class VendorDispatchController {
  constructor(private readonly dispatches: VendorDispatchService) {}

  @Post('vendor-dispatch')
  @ApiOperation({
    summary: 'Offer the ticket to a vendor',
    description:
      'A queued ticket with no technician; the vendor needs a contractor who can take it. The SLA clock runs on.',
  })
  @ApiCreatedResponse({ type: VendorDispatchView })
  async offer(
    @Param('id', parseId()) id: string,
    @Body() dto: OfferToVendorDto,
  ): Promise<VendorDispatchView> {
    return VendorDispatchView.from(await this.dispatches.offer(id, dto));
  }

  /** `reasonCode` from the closed list `vendorDispatchWithdraw`. */
  @Post('vendor-dispatch/withdraw')
  @ApiOperation({ summary: 'Take the offer back from the vendor' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  withdraw(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.dispatches.withdraw(id, dto.reasonCode);
  }

  @Get('vendor-dispatches')
  @ApiOperation({ summary: 'List the ticket’s offers to vendors' })
  @ApiOkResponse({ type: ListOf(VendorDispatchView) })
  async ofTicket(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<VendorDispatchView>> {
    return toList(
      { items: await this.dispatches.ofTicket(id), nextCursor: null },
      (d) => VendorDispatchView.from(d),
    );
  }
}

/**
 * The contractor's app (ADR 0088): its company, and the tickets offered to
 * it. A ticket it takes is then worked under `/technician/tickets`, as a
 * technician works it.
 */
@ApiArea('contractor')
@Controller('contractor')
export class ContractorPortalController {
  constructor(
    private readonly contractors: ContractorsService,
    private readonly dispatches: VendorDispatchService,
    private readonly ctx: RequestContext,
  ) {}

  @Get('vendor')
  @RequireAnyPermission(
    'tickets.contract_work',
    'tenders.bid',
    'vendor_invoices.submit',
    'purchase_orders.acknowledge',
  )
  @ApiOperation({ summary: 'My company' })
  @ApiOkResponse({ type: ContractorVendorView })
  async vendor(): Promise<ContractorVendorView> {
    return ContractorVendorView.from(await this.contractors.myVendor());
  }

  @Get('contracts')
  @RequirePermissions('vendor_invoices.submit')
  @ApiOperation({
    summary: 'List my company’s contracts in force or to come',
    description: 'With their payment schedules: what an invoice is against.',
  })
  @ApiOkResponse({ type: ListOf(ContractorContractView) })
  async contracts(): Promise<ListResponse<ContractorContractView>> {
    return toList(
      { items: await this.contractors.myContracts(), nextCursor: null },
      (c) => ContractorContractView.from(c),
    );
  }

  @Get('dispatches')
  @RequirePermissions('tickets.contract_work')
  @ApiOperation({
    summary: 'List the tickets offered to my company',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(ContractorOfferView) })
  async offers(
    @Query() q: OffersQueryDto,
  ): Promise<ListResponse<ContractorOfferView>> {
    const me = this.ctx.accountId;
    return toList(
      await this.dispatches.offers({ ...q, open: q.open === 'true' }),
      (r) => ContractorOfferView.from(r, me),
    );
  }

  @Post('dispatches/:id/accept')
  @RequirePermissions('tickets.contract_work')
  @ApiOperation({ summary: 'Take the ticket: it is mine to work' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OfferTakenView })
  accept(@Param('id', parseId()) id: string): Promise<OfferTakenView> {
    return this.dispatches.accept(id);
  }

  /** `reasonCode` from the closed list `vendorDispatchDecline`. */
  @Post('dispatches/:id/decline')
  @RequirePermissions('tickets.contract_work')
  @ApiOperation({ summary: 'Turn the ticket down' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  decline(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<void> {
    return this.dispatches.decline(id, dto.reasonCode);
  }
}
