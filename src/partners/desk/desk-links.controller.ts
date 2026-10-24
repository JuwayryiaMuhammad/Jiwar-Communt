import { Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { DeskLinks, type IssuedDeskLink } from './desk-links';

/** A desk link as made: shown once, never again. */
export class IssuedDeskLinkView {
  @ApiProperty({
    type: String,
    description: 'Shown once; the server keeps only its hash.',
  })
  token: string;
  @ApiProperty({
    type: String,
    example: 'https://app.example/p#…',
    description: 'What to give the partner (printed, or sent from the office).',
  })
  link: string;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;

  static from(l: IssuedDeskLink): IssuedDeskLinkView {
    return { token: l.token, link: l.link, expiresAt: l.expiresAt };
  }
}

/** A partner's desk link, for the staff who keep partners (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partners/:id/desk-link')
export class DeskLinksController {
  constructor(private readonly links: DeskLinks) {}

  @Post()
  @NoStore()
  @ApiOperation({
    summary:
      'Make a new desk link for a partner (the one before stops working)',
  })
  @ApiCreatedResponse({ type: IssuedDeskLinkView })
  async issue(@Param('id', parseId()) id: string): Promise<IssuedDeskLinkView> {
    return IssuedDeskLinkView.from(await this.links.issue(id));
  }

  @Post('revoke')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop a partner’s desk link now' })
  @ApiNoContentResponse()
  async revoke(@Param('id', parseId()) id: string): Promise<void> {
    await this.links.revoke(id);
  }
}
