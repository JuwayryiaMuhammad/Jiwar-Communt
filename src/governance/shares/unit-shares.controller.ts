import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  UNIT_SHARE_PATTERN,
  UNIT_SHARES_MAX_WRITE,
  UnitSharesService,
  type UnitSharesRead,
} from './unit-shares.service';

export class UnitShareItemDto {
  @ApiProperty({ type: String, format: 'uuid' })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2.5000',
    description:
      'The unit’s ownership share in %, above 0 and at most 100, up to four decimals; null clears it.',
  })
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @Matches(UNIT_SHARE_PATTERN)
  share: string | null;
}

export class WriteUnitSharesDto {
  @ApiProperty({
    type: [UnitShareItemDto],
    minItems: 1,
    maxItems: UNIT_SHARES_MAX_WRITE,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: UNIT_SHARES_MAX_WRITE }))
  @ArrayMaxSize(
    UNIT_SHARES_MAX_WRITE,
    withParams({ min: 1, max: UNIT_SHARES_MAX_WRITE }),
  )
  @ValidateNested({ each: true })
  @Type(() => UnitShareItemDto)
  shares: UnitShareItemDto[];
}

export class UnitShareView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: '2.5000',
    description:
      'Four decimals; null when none is recorded (the unit weighs 0).',
  })
  share: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt: Date | null;
}

export class UnitSharesView {
  @ApiProperty({ type: [UnitShareView] })
  items: UnitShareView[];
  @ApiProperty({
    type: String,
    example: '100.0000',
    description: 'The recorded shares added up. They need not make 100.',
  })
  total: string;
  @ApiProperty({
    type: Number,
    description:
      'Units with a voting owner and no share: they weigh 0 in a poll weighted by share.',
  })
  missing: number;

  static from(r: UnitSharesRead): UnitSharesView {
    return { items: r.items, total: r.total, missing: r.missing };
  }
}

/** The units' ownership shares, for polls weighted by share (ADR 0075). */
@ApiArea('governance')
@Controller('staff/governance/unit-shares')
export class UnitSharesController {
  constructor(private readonly shares: UnitSharesService) {}

  @Get()
  @RequireAnyPermission('governance.manage', 'governance.board')
  @NoStore()
  @ApiOperation({
    summary: 'The units’ ownership shares',
    description:
      'Every unit with a voting owner now, and any other with a share, by code; the total and how many owned units have none. The manager and the sitting board read them.',
  })
  @ApiOkResponse({ type: UnitSharesView })
  async read(): Promise<UnitSharesView> {
    return UnitSharesView.from(await this.shares.read());
  }

  @Put()
  @RequirePermissions('governance.manage')
  @NoStore()
  @ApiOperation({
    summary: 'Record or clear units’ ownership shares',
    description:
      'Up to 500 units, each once; null clears a share. Each change is audited with the share it replaced. A poll weighted by share takes the shares when its voting opens: a change afterwards does not reach it.',
  })
  @ApiOkResponse({ type: UnitSharesView })
  async write(@Body() dto: WriteUnitSharesDto): Promise<UnitSharesView> {
    return UnitSharesView.from(await this.shares.write(dto.shares));
  }
}
