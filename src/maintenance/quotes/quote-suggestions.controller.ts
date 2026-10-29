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
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { SendSuggestionDto, SuggestQuoteDto } from './dto/quotes.dto';
import { QuoteSuggestionsService } from './quote-suggestions.service';
import { QuoteSuggestionView } from './views/quote.views';

/** The technician's quote suggestions on their ticket (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('tickets.work')
@Controller('technician/tickets/:id/quote-suggestions')
export class TechnicianQuoteSuggestionsController {
  constructor(private readonly suggestions: QuoteSuggestionsService) {}

  @Get()
  @ApiOperation({ summary: 'List my ticket’s suggested quotes, newest first' })
  @ApiOkResponse({ type: ListOf(QuoteSuggestionView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<QuoteSuggestionView>> {
    return bounded(await this.suggestions.list(id, 'technician'), (s) =>
      QuoteSuggestionView.from(s),
    );
  }

  /** Before the work starts, on a resident's unit ticket; one waits at a time. */
  @Post()
  @Idempotent()
  @ApiOperation({ summary: 'Suggest a quote for dispatch to send' })
  @ApiCreatedResponse({ type: QuoteSuggestionView })
  async suggest(
    @Param('id', parseId()) id: string,
    @Body() dto: SuggestQuoteDto,
  ): Promise<QuoteSuggestionView> {
    return QuoteSuggestionView.from(await this.suggestions.suggest(id, dto));
  }
}

/** Dispatch decides the technicians' suggested quotes (ADR 0065). */
@ApiArea('maintenance')
@RequirePermissions('tickets.dispatch')
@Controller('maintenance')
export class DispatchQuoteSuggestionsController {
  constructor(private readonly suggestions: QuoteSuggestionsService) {}

  @Get('tickets/:id/quote-suggestions')
  @ApiOperation({ summary: 'List a ticket’s suggested quotes, newest first' })
  @ApiOkResponse({ type: ListOf(QuoteSuggestionView) })
  async list(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<QuoteSuggestionView>> {
    return bounded(await this.suggestions.list(id, 'dispatch'), (s) =>
      QuoteSuggestionView.from(s),
    );
  }

  /** As a quote of the ticket (ADR 0058), its residents asked to approve. */
  @Post('quote-suggestions/:id/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send a suggested quote to the residents' })
  @ApiOkResponse({ type: QuoteSuggestionView })
  async send(
    @Param('id', parseId()) id: string,
    @Body() dto: SendSuggestionDto,
  ): Promise<QuoteSuggestionView> {
    return QuoteSuggestionView.from(await this.suggestions.send(id, dto));
  }

  /** `reasonCode` from the closed list `quoteSuggestionDismiss`. */
  @Post('quote-suggestions/:id/dismiss')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dismiss a suggested quote' })
  @ApiOkResponse({ type: QuoteSuggestionView })
  async dismiss(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<QuoteSuggestionView> {
    return QuoteSuggestionView.from(
      await this.suggestions.dismiss(id, dto.reasonCode),
    );
  }
}
