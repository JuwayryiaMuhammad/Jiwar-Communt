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
} from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import {
  bounded,
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../common/http/list';
import { ReasonDto, reasonOf } from '../common/http/reason.dto';
import { parseId } from '../common/validation/parse-id.pipe';
import { AccountDeletionService } from './account-deletion.service';
import { EraseDto } from './dto/erasure.dto';
import {
  ErasureScopeView,
  IdView,
  LegalHoldResponse,
  PendingErasureView,
} from './views/erasure.views';

/** Account deletion, the staff's side (ADR 0023): three steps and legal holds. */
@ApiArea('erasure')
@Controller()
export class ErasureController {
  constructor(private readonly deletion: AccountDeletionService) {}

  /** Pending requests, most overdue first. */
  @RequirePermissions('accounts.erase')
  @Get('erasures')
  @ApiOkResponse({ type: ListOf(PendingErasureView) })
  async pending(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PendingErasureView>> {
    return toList(await this.deletion.pendingErasures(q), (p) =>
      PendingErasureView.from(p),
    );
  }

  /** Step 1: counts of what goes and what stays, and the phrase to type. */
  @RequirePermissions('accounts.erase')
  @Get('erasures/:id/scope')
  @ApiOkResponse({ type: ErasureScopeView })
  async scope(@Param('id', parseId()) id: string): Promise<ErasureScopeView> {
    return ErasureScopeView.from(await this.deletion.erasureScope(id));
  }

  /** Step 3: the tombstone. Refused while a legal hold is active. */
  @RequirePermissions('accounts.erase')
  @Post('erasures/:id/erase')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async erase(
    @Param('id', parseId()) id: string,
    @Body() dto: EraseDto,
  ): Promise<void> {
    await this.deletion.erase(id, dto.typedScope);
  }

  /** Step 2: any legal obligation to keep the data. */
  @RequirePermissions('accounts.legal_hold')
  @Get('accounts/:id/legal-holds')
  @ApiOkResponse({ type: ListOf(LegalHoldResponse) })
  async holds(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<LegalHoldResponse>> {
    return bounded(await this.deletion.activeHolds(id), (h) =>
      LegalHoldResponse.from(h),
    );
  }

  /** The person learns their erasure is on hold, never why. */
  @RequirePermissions('accounts.legal_hold')
  @Post('accounts/:id/legal-holds')
  @ApiCreatedResponse({ type: IdView })
  async placeHold(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<IdView> {
    return { id: await this.deletion.placeLegalHold(id, reasonOf(dto)) };
  }

  @RequirePermissions('accounts.legal_hold')
  @Post('legal-holds/:id/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async releaseHold(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.deletion.releaseLegalHold(id, reasonOf(dto));
  }
}
