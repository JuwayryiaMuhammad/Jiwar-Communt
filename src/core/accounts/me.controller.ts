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
} from '@nestjs/swagger';
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
  ) {}

  /** No-store: the photo is a presigned URL (ADR 0031). */
  @Get()
  @NoStore()
  @ApiOkResponse({ type: MeView })
  async me(): Promise<MeView> {
    const account = await this.accounts.me();
    return MeView.from(
      account,
      await this.accounts.myPhotoUrl(),
      await this.roles.current(),
    );
  }

  @Patch('locale')
  @ApiOkResponse({ type: LocaleView })
  async locale(@Body() dto: UpdateLocaleDto): Promise<LocaleView> {
    return {
      preferredLocale: await this.self.updatePreferredLocale(dto.locale),
    };
  }

  /** Live sessions, the current one marked. Never the IP. */
  @Get('sessions')
  @ApiOkResponse({ type: ListOf(SessionView) })
  async sessions(): Promise<ListResponse<SessionView>> {
    return bounded(await this.self.listMySessions(), (s) =>
      SessionView.from(s),
    );
  }

  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: RevokedView })
  async revokeAll(): Promise<RevokedView> {
    return { revoked: await this.self.revokeAllMySessions() };
  }

  @Post('sessions/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revoke(@Param('id', parseId()) id: string): Promise<void> {
    await this.self.revokeSession(id);
  }

  @Get('deletion-request')
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
  @ApiCreatedResponse({ type: DeletionRequestResponse })
  async requestDeletion(
    @Body() dto: DeletionConfirmationDto,
  ): Promise<DeletionRequestResponse> {
    return DeletionRequestResponse.from(
      await this.deletion.requestDeletion(dto.confirmation),
    );
  }

  @Post('deletion-request/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async cancelDeletion(): Promise<void> {
    await this.deletion.cancelDeletion();
  }
}
