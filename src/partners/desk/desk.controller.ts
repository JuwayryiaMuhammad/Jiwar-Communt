import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../core/common/guards/public.decorator';
import { ApiArea, PublicPageHeaders } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { PartnerSideRequestView } from '../requests/views/request.views';
import { DeskService } from './desk.service';
import {
  DeskAcceptDto,
  DeskCancelDto,
  DeskDeclineDto,
  DeskProposeDto,
  DeskTokenDto,
} from './dto/desk.dto';
import { DeskPageView, deskRequestView } from './views/desk.views';

/**
 * The page a partner opens from its desk link (ADR 0060): no account, the
 * link itself is the credential, until the management revokes it or it
 * expires. POST so the token stays in bodies, never in a URL or a log.
 */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/partner-desk')
export class DeskController {
  constructor(private readonly desk: DeskService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open a partner’s desk from its link' })
  @ApiOkResponse({ type: DeskPageView })
  async lookup(
    @Body() dto: DeskTokenDto,
    @Ip() ip: string,
  ): Promise<DeskPageView> {
    return DeskPageView.from(await this.desk.lookup(dto.token, ip));
  }

  @Post('requests/:id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept a request on the desk' })
  @ApiOkResponse({ type: PartnerSideRequestView })
  async accept(
    @Param('id', parseId()) id: string,
    @Body() dto: DeskAcceptDto,
    @Ip() ip: string,
  ): Promise<PartnerSideRequestView> {
    return deskRequestView(
      await this.desk.act(dto.token, ip, id, 'accept', dto),
    );
  }

  @Post('requests/:id/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Decline a request on the desk' })
  @ApiOkResponse({ type: PartnerSideRequestView })
  async decline(
    @Param('id', parseId()) id: string,
    @Body() dto: DeskDeclineDto,
    @Ip() ip: string,
  ): Promise<PartnerSideRequestView> {
    return deskRequestView(
      await this.desk.act(dto.token, ip, id, 'decline', dto),
    );
  }

  @Post('requests/:id/propose')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Propose another window on the desk' })
  @ApiOkResponse({ type: PartnerSideRequestView })
  async propose(
    @Param('id', parseId()) id: string,
    @Body() dto: DeskProposeDto,
    @Ip() ip: string,
  ): Promise<PartnerSideRequestView> {
    return deskRequestView(
      await this.desk.act(dto.token, ip, id, 'propose', dto),
    );
  }

  @Post('requests/:id/done')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a request done on the desk' })
  @ApiOkResponse({ type: PartnerSideRequestView })
  async done(
    @Param('id', parseId()) id: string,
    @Body() dto: DeskTokenDto,
    @Ip() ip: string,
  ): Promise<PartnerSideRequestView> {
    return deskRequestView(
      await this.desk.act(dto.token, ip, id, 'partner_done', {}),
    );
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel an accepted request on the desk' })
  @ApiOkResponse({ type: PartnerSideRequestView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: DeskCancelDto,
    @Ip() ip: string,
  ): Promise<PartnerSideRequestView> {
    return deskRequestView(
      await this.desk.act(dto.token, ip, id, 'partner_cancel', dto),
    );
  }
}
