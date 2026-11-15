import { Module } from '@nestjs/common';
import { AccessTokens } from './access-token';
import { ActionTokens } from './action-tokens';
import { LoginAlerts } from './login-alerts';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailOtpChannel } from './email-otp.channel';
import { IdentifierHasher } from './identifier';
import { OTP_CHANNEL, SMS_OTP_CHANNEL } from './otp-channel';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { SmsLoginPolicy } from './sms-login.policy';
import { SmsOtpChannel } from './sms-otp.channel';
import { StepUpController } from './step-up.controller';
import { StepUpService } from './step-up.service';

@Module({
  controllers: [AuthController, StepUpController],
  providers: [
    AuthService,
    OtpService,
    SessionService,
    IdentifierHasher,
    AccessTokens,
    StepUpService,
    ActionTokens,
    LoginAlerts,
    SmsLoginPolicy,
    { provide: OTP_CHANNEL, useClass: EmailOtpChannel },
    { provide: SMS_OTP_CHANNEL, useClass: SmsOtpChannel },
  ],
  exports: [
    IdentifierHasher,
    AccessTokens,
    OtpService,
    StepUpService,
    ActionTokens,
  ],
})
export class AuthModule {}
