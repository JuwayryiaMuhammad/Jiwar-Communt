import { Module } from '@nestjs/common';
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
    { provide: OTP_CHANNEL, useClass: EmailOtpChannel },
  ],
  exports: [IdentifierHasher, OtpService],
})
export class AuthModule {}
