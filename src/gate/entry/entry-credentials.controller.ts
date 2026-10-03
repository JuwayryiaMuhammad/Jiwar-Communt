import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { IssueEntryCredentialDto } from './dto/entry-credentials.dto';
import { EntryCredentialsService } from './entry-credentials.service';
import {
  EntryCredentialView,
  IssuedEntryCredentialView,
} from './views/entry-credential.views';

/**
 * The caller's phones for the resident's entry QR (ADR 0031). No permission:
 * what decides is the capability `gateEntry` on at least one unit, checked
 * under the account's lock (`NOT_A_RESIDENT` otherwise).
 */
@ApiArea('entry-credentials')
@Controller('me/entry-credentials')
export class EntryCredentialsController {
  constructor(private readonly credentials: EntryCredentialsService) {}

  /** The secret comes back once. A retry with the same key gets the same one. */
  @Post()
  @NoStore()
  @Idempotent({ secret: true })
  @ApiCreatedResponse({ type: IssuedEntryCredentialView })
  async issue(
    @Body() dto: IssueEntryCredentialDto,
  ): Promise<IssuedEntryCredentialView> {
    return IssuedEntryCredentialView.from(await this.credentials.issue(dto));
  }

  @Get()
  @ApiOkResponse({ type: ListOf(EntryCredentialView) })
  async list(): Promise<ListResponse<EntryCredentialView>> {
    return bounded(await this.credentials.list(), (c) =>
      EntryCredentialView.from(c),
    );
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revoke(@Param('id', parseId()) id: string): Promise<void> {
    await this.credentials.revoke(id);
  }
}
