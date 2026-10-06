import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { Public } from '../common/guards/public.decorator';
import { ApiArea } from '../common/http/decorators';
import { parseId } from '../common/validation/parse-id.pipe';
import { withParams } from '../common/validation/validation-errors';
import { NotMeService } from './not-me.service';

export class ActionTokenDto {
  @ApiProperty({
    type: String,
    description:
      'The fragment of the link in the email. Anything that is not a live link answers 404 ACTION_TOKEN_INVALID.',
  })
  @IsString()
  @Length(1, 256, withParams({ min: 1, max: 256 }))
  token: string;
}

/** "Not me" from the app, on the device an alert named (ADR 0036). */
@ApiArea('security')
@Controller('me/devices')
export class MeDevicesController {
  constructor(private readonly notMe: NotMeService) {}

  /** Freezes the account and ends every session, this one included. */
  @Post(':id/not-me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async notMeFromApp(@Param('id', parseId()) id: string): Promise<void> {
    await this.notMe.fromApp(id);
  }
}

/**
 * "Not me" from the alert's email (ADR 0036): no account, the link is the
 * proof. POST so the token stays in bodies, never in a URL or a log.
 */
@ApiArea('security', 'public')
@Public()
@Controller('public')
export class PublicNotMeController {
  constructor(private readonly notMe: NotMeService) {}

  @Post('not-me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async notMeFromEmail(
    @Body() dto: ActionTokenDto,
    @Ip() ip: string,
  ): Promise<void> {
    await this.notMe.fromEmail(dto.token, ip);
  }
}
