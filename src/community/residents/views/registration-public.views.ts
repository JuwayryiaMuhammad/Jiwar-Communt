import { ApiProperty } from '@nestjs/swagger';

/** The one answer to every registrant at start (ADR 0024). */
export class RegistrationCodeSentView {
  @ApiProperty({ enum: ['REGISTRATION_CODE_SENT'] })
  code: 'REGISTRATION_CODE_SENT';
}

/** The one answer at completion, whatever the link or the unit. */
export class RegistrationReceivedView {
  @ApiProperty({ enum: ['REGISTRATION_RECEIVED'] })
  code: 'REGISTRATION_RECEIVED';
}
