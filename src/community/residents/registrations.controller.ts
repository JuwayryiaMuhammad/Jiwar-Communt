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
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  ApproveRegistrationDto,
  PendingRegistrationsQueryDto,
  RegistrationCorrectionDto,
} from './dto/registration.dto';
import { RegistrationService } from './registration.service';
import {
  ApprovedRegistrationView,
  CreatedLinkView,
  PendingRegistrationView,
  RegistrationDocumentReadView,
  RegistrationLinkResponse,
} from './views/registration.views';

/** Self-registration, the manager's side (ADR 0024). */
@ApiArea('registration')
@RequirePermissions('residents.manage')
@Controller()
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationService) {}

  @Get('registration-links')
  @ApiOperation({ summary: 'List registration links' })
  @ApiOkResponse({ type: ListOf(RegistrationLinkResponse) })
  async links(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<RegistrationLinkResponse>> {
    return toList(await this.registrations.listLinks(q), (l) =>
      RegistrationLinkResponse.from(l),
    );
  }

  /** Older live links keep working until revoked. */
  @Post('registration-links')
  @ApiOperation({ summary: 'Create a registration link' })
  @NoStore()
  @ApiCreatedResponse({ type: CreatedLinkView })
  async createLink(): Promise<CreatedLinkView> {
    return CreatedLinkView.from(await this.registrations.createLink());
  }

  @Post('registration-links/:id/revoke')
  @ApiOperation({ summary: 'Revoke a registration link' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeLink(@Param('id', parseId()) id: string): Promise<void> {
    await this.registrations.revokeLink(id);
  }

  /**
   * Undecided requests, oldest first, each with its conflicts as of now and
   * its documents: waiting for the management (`pending`, the default) or
   * sent back to the registrant (`needs_correction`).
   */
  @Get('registrations')
  @ApiOperation({ summary: 'List undecided registration requests' })
  @ApiOkResponse({ type: ListOf(PendingRegistrationView) })
  async pending(
    @Query() q: PendingRegistrationsQueryDto,
  ): Promise<ListResponse<PendingRegistrationView>> {
    return toList(await this.registrations.pending(q), (p) =>
      PendingRegistrationView.from(p),
    );
  }

  /** A document a registrant uploaded, to look at (no-store). */
  @Get('registrations/:id/documents/:documentId')
  @ApiOperation({ summary: 'Read a registration document' })
  @NoStore()
  @ApiOkResponse({ type: RegistrationDocumentReadView })
  async document(
    @Param('id', parseId()) id: string,
    @Param('documentId', parseId('documentId')) documentId: string,
  ): Promise<RegistrationDocumentReadView> {
    return RegistrationDocumentReadView.fromRead(
      await this.registrations.documentUrl(id, documentId),
    );
  }

  /**
   * Sends a pending request back with what to correct (codes only); the
   * registrant gets a new status link. Already sent back:
   * REGISTRATION_CORRECTION_PENDING.
   */
  @Post('registrations/:id/request-correction')
  @ApiOperation({ summary: 'Ask the registrant for a correction' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async requestCorrection(
    @Param('id', parseId()) id: string,
    @Body() dto: RegistrationCorrectionDto,
  ): Promise<void> {
    await this.registrations.requestCorrection(id, dto);
  }

  /** The account and the occupancy are created now; a clash is REGISTRATION_CONFLICT. */
  @Post('registrations/:id/approve')
  @ApiOperation({ summary: 'Approve a registration request' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ApprovedRegistrationView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApproveRegistrationDto,
  ): Promise<ApprovedRegistrationView> {
    return ApprovedRegistrationView.from(
      await this.registrations.approve(id, dto),
    );
  }

  /** The registrant is told, with the reason text. */
  @Post('registrations/:id/reject')
  @ApiOperation({ summary: 'Reject a registration request' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.registrations.reject(id, reasonOf(dto));
  }
}
