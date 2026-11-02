import {
  Body,
  Controller,
  Get,
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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  AcceptWarrantyClaimDto,
  CreateWarrantyClaimDto,
  DecideWarrantyClaimDto,
  WarrantyClaimReferenceDto,
  WarrantyClaimsQueryDto,
} from './dto/warranty-claims.dto';
import { WarrantyClaimView } from './views/warranty-claim.views';
import { WarrantyClaimsService } from './warranty-claims.service';

/** Claims under an asset's warranty (ADR 0076), for `assets.manage`. */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/warranty-claims')
export class WarrantyClaimsController {
  constructor(private readonly claims: WarrantyClaimsService) {}

  @Get()
  @ApiOperation({ summary: 'List the warranty claims, the newest first' })
  @ApiOkResponse({ type: ListOf(WarrantyClaimView) })
  async list(
    @Query() q: WarrantyClaimsQueryDto,
  ): Promise<ListResponse<WarrantyClaimView>> {
    return toList(await this.claims.list(q), (c) => WarrantyClaimView.from(c));
  }

  /** While the warranty runs; at most one open claim per ticket. */
  @Post()
  @ApiOperation({ summary: 'Claim under an asset’s warranty' })
  @Idempotent()
  @ApiCreatedResponse({ type: WarrantyClaimView })
  async create(
    @Body() dto: CreateWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return WarrantyClaimView.from(await this.claims.open(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one warranty claim' })
  @ApiOkResponse({ type: WarrantyClaimView })
  async get(@Param('id', parseId()) id: string): Promise<WarrantyClaimView> {
    return WarrantyClaimView.from(await this.claims.get(id));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Record the warrantor’s reference of an open claim',
  })
  @ApiOkResponse({ type: WarrantyClaimView })
  async reference(
    @Param('id', parseId()) id: string,
    @Body() dto: WarrantyClaimReferenceDto,
  ): Promise<WarrantyClaimView> {
    return WarrantyClaimView.from(
      await this.claims.setReference(id, dto.reference),
    );
  }

  @Post(':id/accept')
  @ApiOperation({
    summary: 'Accepted by the warrantor, with what it recovered',
  })
  @ApiCreatedResponse({ type: WarrantyClaimView })
  async accept(
    @Param('id', parseId()) id: string,
    @Body() dto: AcceptWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return WarrantyClaimView.from(
      await this.claims.accept(id, dto.recoveredAmount),
    );
  }

  @Post(':id/reject')
  @ApiOperation({
    summary:
      'Rejected by the warrantor; `reasonCode` from `warrantyClaimReject`',
  })
  @ApiCreatedResponse({ type: WarrantyClaimView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return WarrantyClaimView.from(await this.claims.reject(id, dto.reasonCode));
  }

  @Post(':id/withdraw')
  @ApiOperation({
    summary:
      'Withdrawn by the compound; `reasonCode` from `warrantyClaimWithdraw`',
  })
  @ApiCreatedResponse({ type: WarrantyClaimView })
  async withdraw(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideWarrantyClaimDto,
  ): Promise<WarrantyClaimView> {
    return WarrantyClaimView.from(
      await this.claims.withdraw(id, dto.reasonCode),
    );
  }
}
