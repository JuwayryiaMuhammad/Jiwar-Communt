import { Global, Module } from '@nestjs/common';
import { BoardMatters } from './board-matters';

/**
 * Board matters (ADR 0055). Global: finance, the gate and facilities
 * register their approval types, appeal kinds and overview sections, and
 * governance its thresholds, at startup.
 */
@Global()
@Module({ providers: [BoardMatters], exports: [BoardMatters] })
export class BoardMattersModule {}
