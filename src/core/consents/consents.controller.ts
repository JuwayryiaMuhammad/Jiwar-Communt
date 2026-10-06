import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { ApiArea } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { ConsentsService } from './consents.service';
import { GrantConsentDto, RevokeConsentDto } from './dto/consents.dto';
import { ConsentView } from './views/consent.views';

/** The caller's own consents (ADR 0036); any tenant account. */
@ApiArea('consents')
@Controller('me/consents')
export class ConsentsController {
  constructor(private readonly consents: ConsentsService) {}

  /** Every consent of the catalog, granted or not. */
  @Get()
  @ApiOkResponse({ type: ListOf(ConsentView) })
  async mine(): Promise<ListResponse<ConsentView>> {
    return bounded(await this.consents.mine(), (s) => ConsentView.from(s));
  }

  @Post('grant')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ConsentView })
  async grant(@Body() dto: GrantConsentDto): Promise<ConsentView> {
    return ConsentView.from(await this.consents.grant(dto.code, dto.version));
  }

  /** Allowed at any time; it takes effect at once. */
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ConsentView })
  async revoke(@Body() dto: RevokeConsentDto): Promise<ConsentView> {
    return ConsentView.from(await this.consents.revoke(dto.code));
  }
}
