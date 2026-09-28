import { Module } from '@nestjs/common';
import { IdentifierHasher } from './identifier';

@Module({
  providers: [IdentifierHasher],
  exports: [IdentifierHasher],
})
export class AuthModule {}
