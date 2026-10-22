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
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { RequestContext } from '../../core/common/cls/request-context';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ProposeQuoteDto } from './dto/quotes.dto';
import { QuotesService } from './quotes.service';
import {
  DispatchQuoteView,
  QuoteCreatedView,
  ResidentQuoteView,
} from './views/quote.views';

/** A ticket's quotes for its residents (ADR 0058). */
@ApiArea('tickets')
@RequirePermissions('tickets.create')
@Controller('tickets/:id/quotes')
export class ResidentQuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly ctx: RequestContext,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the quotes of one of my tickets' })
  @ApiOkResponse({ type: ListOf(ResidentQuoteView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<ResidentQuoteView>> {
    const me = this.ctx.accountId;
    return bounded(await this.quotes.list(id, 'resident'), (q) =>
      ResidentQuoteView.from(q, me),
    );
  }

  /** The reporter or the unit's primary: the work may start. */
  @Post(':quoteId/approve')
  @ApiOperation({ summary: 'Approve a quote of my ticket' })
  @Idempotent()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  approve(
    @Param('id', parseId()) id: string,
    @Param('quoteId', parseId('quoteId')) quoteId: string,
  ): Promise<void> {
    return this.quotes.decide(id, quoteId, 'approve');
  }

  /** `reasonCode` from `ticketQuoteDecline`; the work does not start. */
  @Post(':quoteId/decline')
  @ApiOperation({ summary: 'Decline a quote of my ticket' })
  @Idempotent()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  decline(
    @Param('id', parseId()) id: string,
    @Param('quoteId', parseId('quoteId')) quoteId: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<void> {
    return this.quotes.decide(id, quoteId, 'decline', dto.reasonCode);
  }
}

/** A ticket's quotes for the dispatch (ADR 0058). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance/tickets/:id/quotes')
export class DispatchQuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  @ApiOperation({ summary: 'List the quotes of a ticket' })
  @ApiOkResponse({ type: ListOf(DispatchQuoteView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<DispatchQuoteView>> {
    return bounded(await this.quotes.list(id, 'dispatch'), (q) =>
      DispatchQuoteView.from(q),
    );
  }

  /** Before the work starts, on a unit's ticket; one waits at a time. */
  @Post()
  @ApiOperation({ summary: 'Quote a ticket for its residents to approve' })
  @Idempotent()
  @ApiCreatedResponse({ type: QuoteCreatedView })
  propose(
    @Param('id', parseId()) id: string,
    @Body() dto: ProposeQuoteDto,
  ): Promise<QuoteCreatedView> {
    return this.quotes.propose(id, dto);
  }

  @Post(':quoteId/withdraw')
  @ApiOperation({ summary: 'Withdraw a quote that waits' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  withdraw(
    @Param('id', parseId()) id: string,
    @Param('quoteId', parseId('quoteId')) quoteId: string,
  ): Promise<void> {
    return this.quotes.withdraw(id, quoteId);
  }
}
