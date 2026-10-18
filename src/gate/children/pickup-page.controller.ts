import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea, PublicPageHeaders } from '../../core/common/http/decorators';
import { PickupTokenDto } from './dto/pickup-page.dto';
import { PickupPageService } from './pickup-page.service';
import { PickupPageView } from './views/pickup-page.views';

/**
 * The page an outside escort opens from the household's pickup link (ADR
 * 0054). POST so the token stays in bodies, never in a URL or a log.
 */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/child-pickups')
export class PickupPageController {
  constructor(private readonly page: PickupPageService) {}

  @Post('lookup')
  @ApiOperation({ summary: "Open a child's pickup code from its link" })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: PickupPageView })
  lookup(
    @Body() dto: PickupTokenDto,
    @Ip() ip: string,
  ): Promise<PickupPageView> {
    return this.page.lookup(dto.token, ip);
  }
}
