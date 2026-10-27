import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea, PublicPageHeaders } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  RegistrationStatusTokenDto,
  RegistrationUploadDto,
} from './dto/registration.dto';
import { RegistrationDocumentsService } from './registration-documents.service';
import {
  RegistrationDocumentView,
  RegistrationStatusView,
  RegistrationUploadView,
} from './views/registration-public.views';

/**
 * The page a registrant opens from their status link (ADR 0062): no
 * account, the link itself is the credential until the request is decided.
 * POST so the token stays in bodies, never in a URL or a log. Every link
 * that does not open an undecided request is 404 REGISTRATION_STATUS_NOT_FOUND.
 */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/registrations')
export class RegistrationStatusController {
  constructor(private readonly documents: RegistrationDocumentsService) {}

  @Post('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open a registration request from its status link' })
  @ApiOkResponse({ type: RegistrationStatusView })
  async status(
    @Body() dto: RegistrationStatusTokenDto,
    @Ip() ip: string,
  ): Promise<RegistrationStatusView> {
    return RegistrationStatusView.from(
      await this.documents.lookup(dto.token, ip),
    );
  }

  /** Three live documents at most, uploads not yet finalized included. */
  @Post('uploads')
  @ApiOperation({ summary: 'Start uploading a proof-of-capacity document' })
  @ApiCreatedResponse({ type: RegistrationUploadView })
  async upload(
    @Body() dto: RegistrationUploadDto,
    @Ip() ip: string,
  ): Promise<RegistrationUploadView> {
    const { token, ...input } = dto;
    return RegistrationUploadView.from(
      await this.documents.startUpload(token, ip, input),
    );
  }

  /** The bytes are checked; a mismatch deletes them (FILE_CONTENT_MISMATCH). */
  @Post('documents/:id/finalize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Finalize an uploaded registration document' })
  @ApiOkResponse({ type: RegistrationDocumentView })
  async finalize(
    @Param('id', parseId()) id: string,
    @Body() dto: RegistrationStatusTokenDto,
    @Ip() ip: string,
  ): Promise<RegistrationDocumentView> {
    return RegistrationDocumentView.from(
      await this.documents.finalize(dto.token, ip, id),
    );
  }

  @Post('documents/:id/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a registration document' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', parseId()) id: string,
    @Body() dto: RegistrationStatusTokenDto,
    @Ip() ip: string,
  ): Promise<void> {
    await this.documents.remove(dto.token, ip, id);
  }

  /** After a correction: back to the management, one finalized document at least. */
  @Post('resubmit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a corrected registration request again' })
  @ApiOkResponse({ type: RegistrationStatusView })
  async resubmit(
    @Body() dto: RegistrationStatusTokenDto,
    @Ip() ip: string,
  ): Promise<RegistrationStatusView> {
    return RegistrationStatusView.from(
      await this.documents.resubmit(dto.token, ip),
    );
  }
}
