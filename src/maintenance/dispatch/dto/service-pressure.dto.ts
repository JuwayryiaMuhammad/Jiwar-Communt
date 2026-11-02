import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min, ValidateIf } from 'class-validator';
import { withParams } from '../../../core/common/validation/validation-errors';
import { OPEN_PER_TECHNICIAN } from '../service-pressure';

const range = withParams({ ...OPEN_PER_TECHNICIAN });

export class UpdateServicePressureDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: OPEN_PER_TECHNICIAN.min,
    maximum: OPEN_PER_TECHNICIAN.max,
    description:
      'Open tickets (new, or in a technician’s hands) one available technician may carry before the dispatch and the managers are told; null: no alert.',
  })
  @ValidateIf((o: UpdateServicePressureDto) => o.openPerTechnician !== null)
  @IsInt(range)
  @Min(OPEN_PER_TECHNICIAN.min, range)
  @Max(OPEN_PER_TECHNICIAN.max, range)
  openPerTechnician: number | null;
}
