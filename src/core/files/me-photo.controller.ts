import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Put,
} from '@nestjs/common';
import { ApiNoContentResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import { AccountPhotoService } from './account-photo.service';
import { MyPhotoDto } from './dto/me-photo.dto';

/**
 * The caller's own photo (ADR 0031). It is read back on `GET /me`; the
 * guard sees it on a valid resident scan only.
 */
@ApiArea('me')
@RequirePermissions('profile.photo')
@Controller('me/photo')
export class MePhotoController {
  constructor(private readonly photo: AccountPhotoService) {}

  /** Sets or replaces it; the file moves to the account. */
  @Put()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async set(@Body() dto: MyPhotoDto): Promise<void> {
    await this.photo.set(dto.fileId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(): Promise<void> {
    await this.photo.remove();
  }
}
