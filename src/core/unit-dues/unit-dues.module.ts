import { Global, Module } from '@nestjs/common';
import { UnitDues } from './unit-dues';

/** What a unit owes (ADR 0083): finance registers its reader. */
@Global()
@Module({ providers: [UnitDues], exports: [UnitDues] })
export class UnitDuesModule {}
