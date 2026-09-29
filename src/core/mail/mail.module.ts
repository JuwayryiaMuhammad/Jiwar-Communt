import { Global, Module } from '@nestjs/common';
import { Mailer } from './mailer';

@Global()
@Module({ providers: [Mailer], exports: [Mailer] })
export class MailModule {}
