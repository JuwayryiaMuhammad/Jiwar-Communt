import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { PageQueryDto } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import {
  AddVendorDocumentDto,
  CreateVendorDto,
  EvaluateVendorDto,
  UpdateVendorDto,
  VendorsQueryDto,
} from './dto/vendors.dto';
import { VendorsService } from './vendors.service';
import {
  VendorDocumentView,
  VendorEvaluationView,
  VendorSummaryView,
  VendorView,
} from './views/vendor.views';

/**
 * The compound's vendor register (ADR 0077). Kept with `vendors.manage`;
 * read by who names a vendor: the contracts' and assets' keepers, the
 * budget's, and who asks to buy or approves.
 */
@ApiArea('maintenance')
@Controller('staff/vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @RequireAnyPermission(
    'vendors.manage',
    'assets.manage',
    'finance.budget',
    'purchases.request',
    'purchases.approve',
  )
  @ApiOperation({
    summary: 'List the vendors',
    description: 'In register order.',
  })
  @ApiOkResponse({ type: ListOf(VendorSummaryView) })
  async list(
    @Query() q: VendorsQueryDto,
  ): Promise<ListResponse<VendorSummaryView>> {
    return toList(await this.vendors.list(q), (v) => VendorSummaryView.from(v));
  }

  @Post()
  @Idempotent()
  @RequirePermissions('vendors.manage')
  @ApiOperation({ summary: 'Register a vendor' })
  @ApiCreatedResponse({ type: VendorView })
  async create(@Body() dto: CreateVendorDto): Promise<VendorView> {
    return VendorView.from(await this.vendors.create(dto));
  }

  @Get(':id')
  @RequireAnyPermission(
    'vendors.manage',
    'assets.manage',
    'finance.budget',
    'purchases.request',
    'purchases.approve',
  )
  @ApiOperation({
    summary: 'Get a vendor',
    description:
      'With its live papers, the last year’s evaluations and its contracts.',
  })
  @ApiOkResponse({ type: VendorView })
  async get(@Param('id', parseId()) id: string): Promise<VendorView> {
    return VendorView.from(await this.vendors.get(id));
  }

  @Patch(':id')
  @RequirePermissions('vendors.manage')
  @ApiOperation({ summary: 'Change a vendor’s details' })
  @ApiOkResponse({ type: VendorView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateVendorDto,
  ): Promise<VendorView> {
    return VendorView.from(await this.vendors.update(id, dto));
  }

  /** `reasonCode` from the closed list `vendorSuspend`. */
  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vendors.manage')
  @ApiOperation({
    summary: 'Suspend a vendor',
    description:
      'Its contracts run on; no new contract, expense or purchase request names it.',
  })
  @ApiOkResponse({ type: VendorView })
  async suspend(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<VendorView> {
    return VendorView.from(await this.vendors.suspend(id, dto.reasonCode));
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vendors.manage')
  @ApiOperation({ summary: 'Reinstate a suspended vendor' })
  @ApiOkResponse({ type: VendorView })
  async reinstate(@Param('id', parseId()) id: string): Promise<VendorView> {
    return VendorView.from(await this.vendors.reinstate(id));
  }

  @Post(':id/documents')
  @RequirePermissions('vendors.manage')
  @ApiOperation({ summary: 'File a vendor’s paper' })
  @ApiCreatedResponse({ type: VendorDocumentView })
  async addDocument(
    @Param('id', parseId()) id: string,
    @Body() dto: AddVendorDocumentDto,
  ): Promise<VendorDocumentView> {
    return VendorDocumentView.from(await this.vendors.addDocument(id, dto));
  }

  @Delete(':id/documents/:documentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('vendors.manage')
  @ApiOperation({ summary: 'Remove a paper filed by mistake' })
  @ApiNoContentResponse()
  async removeDocument(
    @Param('id', parseId()) id: string,
    @Param('documentId', parseId('documentId')) documentId: string,
  ): Promise<void> {
    await this.vendors.removeDocument(id, documentId);
  }

  @Post(':id/evaluations')
  @RequirePermissions('vendors.manage')
  @ApiOperation({ summary: 'Evaluate a vendor' })
  @ApiCreatedResponse({ type: VendorView })
  async evaluate(
    @Param('id', parseId()) id: string,
    @Body() dto: EvaluateVendorDto,
  ): Promise<VendorView> {
    return VendorView.from(await this.vendors.evaluate(id, dto));
  }

  @Get(':id/evaluations')
  @RequirePermissions('vendors.manage')
  @ApiOperation({
    summary: 'List a vendor’s evaluations',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(VendorEvaluationView) })
  async evaluations(
    @Param('id', parseId()) id: string,
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<VendorEvaluationView>> {
    return toList(await this.vendors.evaluations(id, q), (e) =>
      VendorEvaluationView.from(e),
    );
  }
}
