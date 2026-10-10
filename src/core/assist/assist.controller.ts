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
import { RequirePermissions } from '../access/require-permissions.decorator';
import { DeletionRequestResponse } from '../accounts/views/me.views';
import { appError, ErrorCode } from '../common/errors';
import { ApiArea } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { ConsentView } from '../consents/views/consent.views';
import { DataExportView } from '../exports/views/data-export.views';
import { PreferencesView } from '../preferences/views/preferences.views';
import { AssistService } from './assist.service';
import {
  AssistGrantDto,
  AssistPreferencesDto,
  AssistReasonDto,
  AssistRevokeDto,
} from './dto/assist.dto';

/**
 * The assisted path (ADR 0036): a manager acting for a resident or family
 * account that does not use the app. Every write takes a reason code, is
 * marked assisted, and tells the account. An export is never handed to the
 * manager: it goes to the account's own email.
 */
@ApiArea('assist')
@RequirePermissions('residents.assist')
@Controller('accounts/:id')
export class AssistController {
  constructor(private readonly assist: AssistService) {}

  @Get('notification-preferences')
  @ApiOkResponse({ type: PreferencesView })
  async preferences(
    @Param('id', parseId()) id: string,
  ): Promise<PreferencesView> {
    return PreferencesView.from(await this.assist.preferencesOf(id));
  }

  @Patch('notification-preferences')
  @ApiOkResponse({ type: PreferencesView })
  async updatePreferences(
    @Param('id', parseId()) id: string,
    @Body() dto: AssistPreferencesDto,
  ): Promise<PreferencesView> {
    const { reasonCode, ...input } = dto;
    return PreferencesView.from(
      await this.assist.updatePreferences(id, input, reasonCode),
    );
  }

  @Get('consents')
  @ApiOkResponse({ type: ListOf(ConsentView) })
  async consents(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<ConsentView>> {
    return bounded(await this.assist.consentsOf(id), (s) =>
      ConsentView.from(s),
    );
  }

  @Post('consents/grant')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ConsentView })
  async grant(
    @Param('id', parseId()) id: string,
    @Body() dto: AssistGrantDto,
  ): Promise<ConsentView> {
    return ConsentView.from(
      await this.assist.grantConsent(id, dto.code, dto.version, dto.reasonCode),
    );
  }

  @Post('consents/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ConsentView })
  async revoke(
    @Param('id', parseId()) id: string,
    @Body() dto: AssistRevokeDto,
  ): Promise<ConsentView> {
    return ConsentView.from(
      await this.assist.revokeConsent(id, dto.code, dto.reasonCode),
    );
  }

  /** Status and dates of the account's latest exports; never a link. */
  @Get('data-exports')
  @ApiOkResponse({ type: ListOf(DataExportView) })
  async exports(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<DataExportView>> {
    return bounded(await this.assist.exportsOf(id), (r) =>
      DataExportView.from(r),
    );
  }

  /** Delivered only to the account's own email; never a link here. */
  @Post('data-exports')
  @ApiCreatedResponse({ type: DataExportView })
  async requestExport(
    @Param('id', parseId()) id: string,
    @Body() dto: AssistReasonDto,
  ): Promise<DataExportView> {
    return DataExportView.from(
      await this.assist.requestExport(id, dto.reasonCode),
    );
  }

  /** The account's latest deletion request (DELETION_REQUEST_NOT_FOUND: none). */
  @Get('deletion-request')
  @ApiOkResponse({ type: DeletionRequestResponse })
  async deletionRequest(
    @Param('id', parseId()) id: string,
  ): Promise<DeletionRequestResponse> {
    const request = await this.assist.deletionRequestOf(id);
    if (!request) {
      throw appError.notFound(
        ErrorCode.DELETION_REQUEST_NOT_FOUND,
        'No deletion request',
      );
    }
    return DeletionRequestResponse.from(request);
  }

  @Post('deletion-request')
  @ApiCreatedResponse({ type: DeletionRequestResponse })
  async requestDeletion(
    @Param('id', parseId()) id: string,
    @Body() dto: AssistReasonDto,
  ): Promise<DeletionRequestResponse> {
    return DeletionRequestResponse.from(
      await this.assist.requestDeletion(id, dto.reasonCode),
    );
  }

  @Post('deletion-request/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async cancelDeletion(
    @Param('id', parseId()) id: string,
    @Body() dto: AssistReasonDto,
  ): Promise<void> {
    await this.assist.cancelDeletion(id, dto.reasonCode);
  }
}
