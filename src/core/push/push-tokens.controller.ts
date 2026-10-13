import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiHeader, ApiNoContentResponse, ApiOperation } from '@nestjs/swagger';
import { INSTALL_ID_HEADER } from '../auth/devices';
import { ApiArea, RequestHeader } from '../common/http/decorators';
import { RegisterPushTokenDto } from './dto/push-tokens.dto';
import { PushDevices } from './push-devices.service';

const InstallId = () =>
  ApiHeader({
    name: INSTALL_ID_HEADER,
    required: false,
    description:
      'The install id (a UUID made at install), the same one sent at login. Needed here: `INSTALL_ID_REQUIRED` without it.',
  });

/**
 * This install's push token (ADR 0041), for any signed-in tenant account:
 * the resident and the staff apps alike. Nothing here returns a token.
 */
@ApiArea('push')
@Controller('me/push-tokens')
export class PushTokensController {
  constructor(private readonly devices: PushDevices) {}

  @Post()
  @ApiOperation({ summary: "Register this install's push token" })
  @InstallId()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async register(
    @RequestHeader(INSTALL_ID_HEADER) installId: string | undefined,
    @Body() dto: RegisterPushTokenDto,
  ): Promise<void> {
    await this.devices.register(installId, dto);
  }

  @Delete()
  @ApiOperation({ summary: "Remove this install's push token" })
  @InstallId()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @RequestHeader(INSTALL_ID_HEADER) installId: string | undefined,
  ): Promise<void> {
    await this.devices.remove(installId);
  }
}
