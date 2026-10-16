import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { DerivedGrants } from '../access/derived-grants';
import { RolesService } from '../access/roles.service';
import { appError, ErrorCode } from '../common/errors';
import { ApiArea, NoStore } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { AccountDeletionService } from './account-deletion.service';
import { AccountSelfService } from './account-self.service';
import { AccountsService } from './accounts.service';
import { DeletionConfirmationDto, UpdateLocaleDto } from './dto/me.dto';
import {
  DeletionRequestResponse,
  LocaleView,
  MeView,
  RevokedView,
  SessionView,
} from './views/me.views';

/**
 * What any signed-in tenant account manages for itself. Nothing here takes
 * another account's id; units and delegations are under /me too (the
 * community domain's MeUnitsController).
 */
@ApiArea('me')
@Controller('me')
export class MeController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly roles: RolesService,
    private readonly self: AccountSelfService,
    private readonly deletion: AccountDeletionService,
    private readonly derived: DerivedGrants,
  ) {}

  /** No-store: the photo is a presigned URL (ADR 0031). */
  @Get()
  @ApiOperation({ summary: 'Get the signed-in account, its roles and photo' })
  @NoStore()
  @ApiOkResponse({ type: MeView })
  async me(): Promise<MeView> {
    const account = await this.accounts.me();
    return MeView.from(
      account,
      await this.accounts.myPhotoUrl(),
      await this.roles.current(),
      await this.derived.heldBy(account.id),
    );
  }

  @Patch('locale')
  @ApiOperation({ summary: 'Set my preferred language' })
  @ApiOkResponse({ type: LocaleView })
  async locale(@Body() dto: UpdateLocaleDto): Promise<LocaleView> {
    return {
      preferredLocale: await this.self.updatePreferredLocale(dto.locale),
    };
  }

  /** Live sessions, the current one marked. Never the IP. */
  @Get('sessions')
  @ApiOperation({ summary: 'List my live sessions, the current one marked' })
  @ApiOkResponse({ type: ListOf(SessionView) })
  async sessions(): Promise<ListResponse<SessionView>> {
    return bounded(await this.self.listMySessions(), (s) =>
      SessionView.from(s),
    );
  }

  @Post('sessions/revoke-all')
  @ApiOperation({ summary: 'Sign out every one of my sessions' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: RevokedView })
  async revokeAll(): Promise<RevokedView> {
    return { revoked: await this.self.revokeAllMySessions() };
  }

  @Post('sessions/:id/revoke')
  @ApiOperation({ summary: 'Sign out one of my sessions' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revoke(@Param('id', parseId()) id: string): Promise<void> {
    await this.self.revokeSession(id);
  }

  @Get('deletion-request')
  @ApiOperation({ summary: 'Get my account deletion request' })
  @ApiOkResponse({ type: DeletionRequestResponse })
  async deletionRequest(): Promise<DeletionRequestResponse> {
    const request = await this.deletion.myDeletionRequest();
    if (!request) {
      throw appError.notFound(
        ErrorCode.DELETION_REQUEST_NOT_FOUND,
        'No deletion request',
      );
    }
    return DeletionRequestResponse.from(request);
  }

  /** Undo is possible until `effectiveAt` (ADR 0023). */
  @Post('deletion-request')
  @ApiOperation({ summary: 'Request deletion of my account' })
  @ApiCreatedResponse({ type: DeletionRequestResponse })
  async requestDeletion(
    @Body() dto: DeletionConfirmationDto,
  ): Promise<DeletionRequestResponse> {
    return DeletionRequestResponse.from(
      await this.deletion.requestDeletion(dto.confirmation),
    );
  }

  @Post('deletion-request/cancel')
  @ApiOperation({ summary: 'Cancel my account deletion request' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async cancelDeletion(): Promise<void> {
    await this.deletion.cancelDeletion();
  }
}
