import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse } from '@nestjs/swagger';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea, PublicPageHeaders } from '../../core/common/http/decorators';
import { VisitorTokenDto } from './dto/visitor-page.dto';
import { VisitorPageService } from './visitor-page.service';
import { VisitorPageView } from './views/visitor-page.views';

/**
 * The page a visitor opens from the host's link (ADR 0030): no account,
 * the link itself is the verification. POST so the token stays in bodies,
 * never in a URL or an access log.
 */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/visitor-passes')
export class VisitorPageController {
  constructor(private readonly page: VisitorPageService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VisitorPageView })
  async lookup(
    @Body() dto: VisitorTokenDto,
    @Ip() ip: string,
  ): Promise<VisitorPageView> {
    return VisitorPageView.from(await this.page.lookup(dto.token, ip));
  }

  /** "This isn't me": the pass is cancelled; nothing is asked of the visitor. */
  @Post('not-me')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async notMe(@Body() dto: VisitorTokenDto, @Ip() ip: string): Promise<void> {
    await this.page.notMe(dto.token, ip);
  }
}
