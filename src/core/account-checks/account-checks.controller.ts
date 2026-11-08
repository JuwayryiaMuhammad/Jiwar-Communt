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
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { AccessReviewsService } from './access-reviews.service';
import { DanglingAccountsService } from './dangling-accounts.service';
import {
  DanglingFindingsQueryDto,
  DecideAccessReviewLineDto,
  KeepDanglingAccountDto,
  UpdateAccountCheckSettingsDto,
} from './dto/account-checks.dto';
import {
  AccessReviewDetailView,
  AccessReviewView,
  AccountCheckSettingsView,
  DanglingFindingView,
} from './views/account-checks.views';

/**
 * The account checks (ADR 0090): dangling accounts and access reviews of
 * the compound's side, by `accounts.manage` (the owner's decision).
 */
@ApiArea('accounts')
@RequirePermissions('accounts.manage')
@Controller('staff/access')
export class AccountChecksController {
  constructor(
    private readonly reviews: AccessReviewsService,
    private readonly dangling: DanglingAccountsService,
  ) {}

  @Get('settings')
  @NoStore()
  @ApiOperation({
    summary: 'Get the account checks’ settings',
    description: 'The idle days (60 by default) and the reviews’ cadence (90).',
  })
  @ApiOkResponse({ type: AccountCheckSettingsView })
  async settings(): Promise<AccountCheckSettingsView> {
    return AccountCheckSettingsView.from(await this.reviews.settings());
  }

  @Patch('settings')
  @NoStore()
  @ApiOperation({ summary: 'Change the account checks’ settings' })
  @ApiOkResponse({ type: AccountCheckSettingsView })
  async updateSettings(
    @Body() dto: UpdateAccountCheckSettingsDto,
  ): Promise<AccountCheckSettingsView> {
    return AccountCheckSettingsView.from(
      await this.reviews.updateSettings(dto),
    );
  }

  // --- dangling accounts ------------------------------------------------------

  @Get('dangling-accounts')
  @NoStore()
  @ApiOperation({
    summary: 'List the dangling-account findings',
    description: 'Newest first, 500 at most.',
  })
  @ApiOkResponse({ type: ListOf(DanglingFindingView) })
  async findings(
    @Query() q: DanglingFindingsQueryDto,
  ): Promise<ListResponse<DanglingFindingView>> {
    return bounded(await this.dangling.list(q), (r) =>
      DanglingFindingView.from(r),
    );
  }

  @Get('dangling-accounts/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a dangling-account finding' })
  @ApiOkResponse({ type: DanglingFindingView })
  async finding(
    @Param('id', parseId()) id: string,
  ): Promise<DanglingFindingView> {
    return DanglingFindingView.from(await this.dangling.get(id));
  }

  @Post('dangling-accounts/:id/keep')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Keep a dangling account',
    description:
      'Once, with a code from `danglingKeep`: not found again for 90 days. Never my own (409 CANNOT_CHANGE_OWN_STATUS).',
  })
  @ApiOkResponse({ type: DanglingFindingView })
  async keep(
    @Param('id', parseId()) id: string,
    @Body() dto: KeepDanglingAccountDto,
  ): Promise<DanglingFindingView> {
    return DanglingFindingView.from(
      await this.dangling.keep(id, dto.reasonCode),
    );
  }

  @Post('dangling-accounts/:id/deactivate')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a dangling account',
    description:
      'Once: the account is deactivated in the same transaction, as a status change is (its sessions end, the domains react).',
  })
  @ApiOkResponse({ type: DanglingFindingView })
  async deactivate(
    @Param('id', parseId()) id: string,
  ): Promise<DanglingFindingView> {
    return DanglingFindingView.from(await this.dangling.deactivate(id));
  }

  // --- access reviews ---------------------------------------------------------

  @Get('reviews')
  @NoStore()
  @ApiOperation({
    summary: 'List the access reviews',
    description: 'Newest first, 100 at most.',
  })
  @ApiOkResponse({ type: ListOf(AccessReviewView) })
  async list(): Promise<ListResponse<AccessReviewView>> {
    return bounded(await this.reviews.list(), (r) => AccessReviewView.from(r));
  }

  @Post('reviews')
  @NoStore()
  @ApiOperation({
    summary: 'Open an access review now',
    description:
      'A frozen snapshot of every active staff, manager and contractor account: its role, the role’s permissions, its last sign-in. One open at a time (409 ACCESS_REVIEW_OPEN).',
  })
  @ApiCreatedResponse({ type: AccessReviewDetailView })
  async open(): Promise<AccessReviewDetailView> {
    return AccessReviewDetailView.fromDetail(await this.reviews.openNow());
  }

  @Get('reviews/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get an access review, with its lines' })
  @ApiOkResponse({ type: AccessReviewDetailView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<AccessReviewDetailView> {
    return AccessReviewDetailView.fromDetail(await this.reviews.get(id));
  }

  @Post('reviews/:id/lines/:lineId/decide')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Keep or revoke a line of an access review',
    description:
      'Once, never my own line (403 ACCESS_REVIEW_OWN_LINE). `revoke` deactivates the account in the same transaction; the system manager’s line is kept only (409 ACCESS_REVIEW_LINE_PROTECTED). The review closes with its last line.',
  })
  @ApiOkResponse({ type: AccessReviewDetailView })
  async decide(
    @Param('id', parseId()) id: string,
    @Param('lineId', parseId('lineId')) lineId: string,
    @Body() dto: DecideAccessReviewLineDto,
  ): Promise<AccessReviewDetailView> {
    return AccessReviewDetailView.fromDetail(
      await this.reviews.decide(id, lineId, dto.decision),
    );
  }
}
