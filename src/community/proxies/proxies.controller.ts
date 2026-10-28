import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { Public } from '../../core/common/guards/public.decorator';
import {
  ApiArea,
  NoStore,
  RequestHeader,
} from '../../core/common/http/decorators';
import { resolveLocale } from '../../core/common/i18n/locale';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CompleteProxyDto,
  NewProxyDto,
  ProxyTokenDto,
} from './dto/proxies.dto';
import { ProxiesService } from './proxies.service';
import { ProxyAcceptanceService } from './proxy-acceptance.service';
import {
  CreatedProxyView,
  PROXY_CODE_REQUESTED,
  ProxyAcceptedView,
  ProxyCodeRequestedView,
  ProxyPlaceView,
  ProxyView,
} from './views/proxy.views';

/** A unit's proxies, its owners' (ADR 0063); never a delegate's. */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller('units/:unitId/proxies')
export class ProxiesController {
  constructor(private readonly proxies: ProxiesService) {}

  @Get()
  @ApiOperation({ summary: 'The unit’s proxies' })
  @ApiOkResponse({ type: [ProxyView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ProxyView[]> {
    return (await this.proxies.list(unitId)).map((p) => ProxyView.from(p));
  }

  /** The link's token is shown once. */
  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Appoint a proxy for the unit' })
  @ApiCreatedResponse({ type: CreatedProxyView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: NewProxyDto,
  ): Promise<CreatedProxyView> {
    const { proxy, token } = await this.proxies.create(unitId, dto);
    return { proxy: ProxyView.from(proxy), token };
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'End a proxy of the unit' })
  @ApiOkResponse({ type: ProxyView })
  async revoke(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Param('id', parseId()) id: string,
  ): Promise<ProxyView> {
    return ProxyView.from(await this.proxies.revoke(unitId, id));
  }
}

/** The units a proxy looks after (ADR 0063). */
@ApiArea('units')
@RequirePermissions('units.read')
@Controller('me/proxy-units')
export class MyProxyUnitsController {
  constructor(private readonly proxies: ProxiesService) {}

  @Get()
  @ApiOperation({ summary: 'The units I look after as a proxy' })
  @ApiOkResponse({ type: [ProxyPlaceView] })
  async mine(): Promise<ProxyPlaceView[]> {
    return (await this.proxies.mine()).map((p) => ProxyPlaceView.from(p));
  }
}

/** A unit's proxies, as the management sees them: read only (ADR 0063). */
@ApiArea('units')
@RequirePermissions('residents.manage')
@Controller('staff/units/:unitId/proxies')
export class StaffProxiesController {
  constructor(private readonly proxies: ProxiesService) {}

  @Get()
  @ApiOperation({ summary: 'A unit’s proxies' })
  @ApiOkResponse({ type: [ProxyView] })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ProxyView[]> {
    return (await this.proxies.staffList(unitId)).map((p) => ProxyView.from(p));
  }
}

/**
 * Accepting a proxy invite (ADR 0063), before the person has an account.
 * Rate-limited; the answers never tell a valid token from an invalid one.
 */
@ApiArea('public', 'public')
@Public()
@Controller('proxy-invites/accept')
export class ProxyAcceptanceController {
  constructor(private readonly acceptance: ProxyAcceptanceService) {}

  @Post('start')
  @ApiOperation({ summary: 'Start accepting a proxy invite (emails a code)' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({ type: ProxyCodeRequestedView })
  async start(
    @Body() dto: ProxyTokenDto,
    @Ip() ip: string,
    @RequestHeader('accept-language') acceptLanguage?: string,
  ): Promise<ProxyCodeRequestedView> {
    await this.acceptance.start(dto.token, ip, resolveLocale(acceptLanguage));
    return PROXY_CODE_REQUESTED;
  }

  /** Every failure is the same 401 OTP_INVALID. */
  @Post('complete')
  @ApiOperation({ summary: 'Accept a proxy invite with the code' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: ProxyAcceptedView })
  async complete(
    @Body() dto: CompleteProxyDto,
    @Ip() ip: string,
  ): Promise<ProxyAcceptedView> {
    await this.acceptance.complete(dto.token, dto.code, ip);
    return { accepted: true };
  }
}
