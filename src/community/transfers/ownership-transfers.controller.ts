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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  ApproveOwnershipTransferDto,
  CancelOwnershipTransferDto,
  OwnershipTransfersQueryDto,
  RequestOwnershipTransferDto,
} from './dto/ownership-transfers.dto';
import { OwnershipTransfersService } from './ownership-transfers.service';
import { OwnershipTransferView } from './views/ownership-transfer.views';

/** Ownership transfer requests and their dues gate (ADR 0083). */
@ApiArea('unit-states')
@RequirePermissions('residents.manage')
@Controller('staff')
export class OwnershipTransfersController {
  constructor(private readonly transfers: OwnershipTransfersService) {}

  /** One waits per unit; it waits in the staff inbox. */
  @Post('units/:unitId/ownership-transfers')
  @ApiOperation({ summary: 'Request an ownership transfer of the unit' })
  @Idempotent()
  @ApiCreatedResponse({ type: OwnershipTransferView })
  async request(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: RequestOwnershipTransferDto,
  ): Promise<OwnershipTransferView> {
    return OwnershipTransferView.from(
      await this.transfers.request(
        unitId,
        { toAccountId: dto.toAccountId, resides: dto.resides },
        reasonOf(dto),
      ),
    );
  }

  @Get('ownership-transfers')
  @ApiOperation({
    summary: 'List ownership transfers, the newest first, with what is owed',
  })
  @ApiOkResponse({ type: ListOf(OwnershipTransferView) })
  async list(
    @Query() q: OwnershipTransfersQueryDto,
  ): Promise<ListResponse<OwnershipTransferView>> {
    return toList(await this.transfers.list(q), (r) =>
      OwnershipTransferView.from(r),
    );
  }

  @Get('ownership-transfers/:id')
  @ApiOperation({ summary: 'Get one ownership transfer' })
  @ApiOkResponse({ type: OwnershipTransferView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<OwnershipTransferView> {
    return OwnershipTransferView.from(await this.transfers.get(id));
  }

  /**
   * Carries the transfer out. A unit that owes is TRANSFER_DUES_OWED,
   * unless `duesExceptionCode` is given with a fresh step-up
   * (STEP_UP_REQUIRED otherwise).
   */
  @Post('ownership-transfers/:id/approve')
  @ApiOperation({ summary: 'Approve an ownership transfer and carry it out' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OwnershipTransferView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApproveOwnershipTransferDto,
  ): Promise<OwnershipTransferView> {
    return OwnershipTransferView.from(
      await this.transfers.approve(id, dto.duesExceptionCode),
    );
  }

  @Post('ownership-transfers/:id/cancel')
  @ApiOperation({ summary: 'Cancel a waiting ownership transfer' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OwnershipTransferView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelOwnershipTransferDto,
  ): Promise<OwnershipTransferView> {
    return OwnershipTransferView.from(
      await this.transfers.cancel(id, dto.reasonCode),
    );
  }
}
