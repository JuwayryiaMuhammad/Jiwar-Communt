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
import { ApproveRegistrationDto } from './dto/registration.dto';
import { RegistrationService } from './registration.service';
import {
  ApprovedRegistrationView,
  CreatedLinkView,
  PendingRegistrationView,
  RegistrationLinkResponse,
} from './views/registration.views';

/** Self-registration, the manager's side (ADR 0024). */
@ApiArea('registration')
@RequirePermissions('residents.manage')
@Controller()
export class RegistrationsController {
  constructor(private readonly registrations: RegistrationService) {}

  @Get('registration-links')
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
  @NoStore()
  @ApiCreatedResponse({ type: CreatedLinkView })
  async createLink(): Promise<CreatedLinkView> {
    return CreatedLinkView.from(await this.registrations.createLink());
  }

  @Post('registration-links/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeLink(@Param('id', parseId()) id: string): Promise<void> {
    await this.registrations.revokeLink(id);
  }

  /** Pending requests, oldest first, each with its conflicts as of now. */
  @Get('registrations')
  @ApiOkResponse({ type: ListOf(PendingRegistrationView) })
  async pending(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<PendingRegistrationView>> {
    return toList(await this.registrations.pending(q), (p) =>
      PendingRegistrationView.from(p),
    );
  }

  /** The account and the occupancy are created now; a clash is REGISTRATION_CONFLICT. */
  @Post('registrations/:id/approve')
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.registrations.reject(id, reasonOf(dto));
  }
}
