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
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import { parseId } from '../common/validation/parse-id.pipe';
import { ContactChangeService } from './contact-change.service';
import {
  NewEmailDto,
  NewIdentityChangeDto,
  VerifyNewEmailDto,
} from './dto/self-contact.dto';
import { IdentityChangesService } from './identity-changes.service';
import { IdentityChangeView } from './views/identity-change.views';

/**
 * A resident's or a family member's own contact and identity (ADR 0062):
 * the email they change themselves, proven at both ends; the name and the
 * phone they ask the management to change.
 */
@ApiArea('me')
@RequirePermissions('profile.contact')
@Controller('me')
export class SelfContactController {
  constructor(
    private readonly contact: ContactChangeService,
    private readonly identity: IdentityChangesService,
  ) {}

  /** Spends a step-up (STEP_UP_REQUIRED) and sends a code to the new email. */
  @Post('contact/email')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Start changing the account’s email' })
  @ApiNoContentResponse()
  async requestEmail(@Body() dto: NewEmailDto): Promise<void> {
    await this.contact.requestEmail(dto);
  }

  /** The code from the new address makes it the account's; the old one is told. */
  @Post('contact/email/verify')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm the new email with its code' })
  @ApiNoContentResponse()
  async verifyEmail(@Body() dto: VerifyNewEmailDto): Promise<void> {
    await this.contact.verifyEmail(dto);
  }

  @Get('identity-changes')
  @ApiOperation({ summary: 'My name and phone change requests' })
  @ApiOkResponse({ type: [IdentityChangeView] })
  async mine(): Promise<IdentityChangeView[]> {
    return (await this.identity.mine()).map((r) => IdentityChangeView.from(r));
  }

  /** Spends a step-up; one pending at a time (IDENTITY_CHANGE_PENDING). */
  @Post('identity-changes')
  @ApiOperation({ summary: 'Ask the management to change my name or phone' })
  @ApiCreatedResponse({ type: IdentityChangeView })
  async ask(@Body() dto: NewIdentityChangeDto): Promise<IdentityChangeView> {
    return IdentityChangeView.from(await this.identity.ask(dto));
  }

  @Post('identity-changes/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Withdraw my pending change request' })
  @ApiOkResponse({ type: IdentityChangeView })
  async cancel(
    @Param('id', parseId()) id: string,
  ): Promise<IdentityChangeView> {
    return IdentityChangeView.from(await this.identity.cancel(id));
  }
}
