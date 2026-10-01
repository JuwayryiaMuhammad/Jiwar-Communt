import { Module } from '@nestjs/common';
import { AccessTokens } from './access-token';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailOtpChannel } from './email-otp.channel';
import { IdentifierHasher } from './identifier';
import { OTP_CHANNEL } from './otp-channel';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    OtpService,
    SessionService,
    IdentifierHasher,
    AccessTokens,
    { provide: OTP_CHANNEL, useClass: EmailOtpChannel },
  ],
  exports: [IdentifierHasher, AccessTokens, OtpService],
})
export class AuthModule {}
