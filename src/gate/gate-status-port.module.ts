import { Module } from '@nestjs/common';
import { GateStatusPort } from './gate-status-port';

/** The gates' status for other domains (ADR 0040), exported through index.ts. */
@Module({ providers: [GateStatusPort], exports: [GateStatusPort] })
export class GateStatusPortModule {}
