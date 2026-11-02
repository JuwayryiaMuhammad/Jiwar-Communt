import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiProperty,
} from '@nestjs/swagger';
import { OccupancyType } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { Public } from '../../core/common/guards/public.decorator';
import {
  ApiArea,
  NoStore,
  PublicPageHeaders,
} from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { LetterPageService } from './letter-page.service';
import {
  ADDRESSEE,
  LETTER_KINDS,
  LETTER_SUBJECT,
  letterNumber,
  type LetterKind,
} from './letter-rules';
import {
  LettersService,
  type LetterRead,
  type PublicLetter,
} from './letters.service';

export class IssueLetterDto {
  @ApiProperty({ enum: LETTER_KINDS })
  @IsIn(LETTER_KINDS, withParams({ allowed: [...LETTER_KINDS] }))
  kind: LetterKind;

  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'The owner or tenant it names: an active occupancy of the unit (OFFICIAL_LETTER_NOT_OCCUPANT).',
  })
  @IsUUID()
  accountId: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The request it answers: one of the account’s.',
  })
  @IsOptional()
  @IsUUID()
  requestId?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: ADDRESSEE.min,
    maxLength: ADDRESSEE.max,
    description: 'To whom, printed on the letter.',
  })
  @IsOptional()
  @IsString()
  @Length(ADDRESSEE.min, ADDRESSEE.max, withParams(ADDRESSEE))
  addressee?: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: LETTER_SUBJECT.min,
    maxLength: LETTER_SUBJECT.max,
    description:
      'What it is about, printed on it. Required for `no_objection`.',
  })
  @IsOptional()
  @IsString()
  @Length(LETTER_SUBJECT.min, LETTER_SUBJECT.max, withParams(LETTER_SUBJECT))
  subject?: string;
}

export class RevokeLetterDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `officialLetterRevoke`.',
  })
  @IsString()
  reasonCode: string;
}

export class LettersQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  accountId?: string;
}

export class LetterCodeDto {
  @ApiProperty({
    type: String,
    description: 'The 22 characters printed on the letter.',
  })
  @IsString()
  @Length(1, 64, withParams({ min: 1, max: 64 }))
  code: string;
}

/** An official letter, as the staff and its subject read it. */
export class LetterView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'OL-000123' })
  number: string;
  @ApiProperty({ enum: LETTER_KINDS })
  kind: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'As written on the letter; null once its subject was erased.',
  })
  subjectName: string | null;
  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  occupancyType: OccupancyType;
  @ApiProperty({ type: String, format: 'date' })
  occupancySince: string;
  @ApiProperty({ type: String, nullable: true })
  addressee: string | null;
  @ApiProperty({ type: String, nullable: true })
  subject: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  issuedAt: Date;
  @ApiProperty({ enum: ['valid', 'revoked'] })
  status: 'valid' | 'revoked';
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  revokedAt: Date | null;
  @ApiProperty({ type: String, nullable: true })
  revokeReason: string | null;
  @ApiProperty({
    type: String,
    description: 'Anyone checks it with this code on the public page.',
  })
  verifyCode: string;

  static from(r: LetterRead): LetterView {
    const l = r.letter;
    return {
      id: l.id,
      number: letterNumber(l.number),
      kind: l.kind,
      unitId: l.unitId,
      unitCode: r.unitCode,
      accountId: l.accountId,
      subjectName: l.subjectName,
      occupancyType: l.occupancyType,
      occupancySince: l.occupancySince.toISOString().slice(0, 10),
      addressee: l.addressee,
      subject: l.subject,
      requestId: l.requestId,
      issuedAt: l.issuedAt,
      status: r.status,
      revokedAt: l.revokedAt,
      revokeReason: l.revokeReason,
      verifyCode: l.verifyCode,
    };
  }
}

/** What anyone learns from a letter's code: nothing but these three. */
export class PublicLetterView {
  @ApiProperty({ enum: ['valid', 'revoked'] })
  status: 'valid' | 'revoked';
  @ApiProperty({ type: String, description: 'The compound that issued it.' })
  issuer: string;
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The day it was issued, in the compound’s zone.',
  })
  issuedOn: string;

  static from(p: PublicLetter): PublicLetterView {
    return { status: p.status, issuer: p.issuer, issuedOn: p.issuedOn };
  }
}

const pdf = (name: string, body: Buffer) =>
  new StreamableFile(body, {
    type: 'application/pdf',
    disposition: `attachment; filename="${name}"`,
  });

/** Official letters, the management's side (ADR 0080, `letters.issue`). */
@ApiArea('management-requests')
@RequirePermissions('letters.issue')
@Controller('staff/official-letters')
export class StaffLettersController {
  constructor(private readonly letters: LettersService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the official letters' })
  @ApiOkResponse({ type: ListOf(LetterView) })
  async list(@Query() q: LettersQueryDto): Promise<ListResponse<LetterView>> {
    return toList(await this.letters.list(q), (r) => LetterView.from(r));
  }

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Issue an official letter' })
  @ApiCreatedResponse({ type: LetterView })
  async issue(@Body() dto: IssueLetterDto): Promise<LetterView> {
    return LetterView.from(await this.letters.issue(dto));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get one official letter' })
  @ApiOkResponse({ type: LetterView })
  async get(@Param('id', parseId()) id: string): Promise<LetterView> {
    return LetterView.from(await this.letters.get(id, false));
  }

  @Post(':id/revoke')
  @NoStore()
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke an official letter' })
  @ApiNoContentResponse()
  async revoke(
    @Param('id', parseId()) id: string,
    @Body() dto: RevokeLetterDto,
  ): Promise<void> {
    await this.letters.revoke(id, dto.reasonCode);
  }

  @Get(':id/pdf')
  @NoStore()
  @ApiOperation({ summary: 'An official letter as a PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async document(@Param('id', parseId()) id: string): Promise<StreamableFile> {
    const { name, body } = await this.letters.document(id, false);
    return pdf(name, body);
  }
}

/** The letters that name the caller (ADR 0080). */
@ApiArea('management-requests')
@RequirePermissions('units.read')
@Controller('me/official-letters')
export class MyLettersController {
  constructor(private readonly letters: LettersService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the official letters issued for me' })
  @ApiOkResponse({ type: ListOf(LetterView) })
  async list(@Query() q: PageQueryDto): Promise<ListResponse<LetterView>> {
    return toList(await this.letters.mine(q), (r) => LetterView.from(r));
  }

  @Get(':id/pdf')
  @NoStore()
  @ApiOperation({ summary: 'An official letter of mine as a PDF' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async document(@Param('id', parseId()) id: string): Promise<StreamableFile> {
    const { name, body } = await this.letters.document(id, true);
    return pdf(name, body);
  }
}

/** Anyone checks a letter by its code (ADR 0080), as a clearance is checked. */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/letters')
export class PublicLettersController {
  constructor(private readonly page: LetterPageService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Check an official letter by its code' })
  @ApiOkResponse({ type: PublicLetterView })
  async lookup(
    @Body() dto: LetterCodeDto,
    @Ip() ip: string,
  ): Promise<PublicLetterView> {
    return PublicLetterView.from(await this.page.lookup(dto.code, ip));
  }
}
