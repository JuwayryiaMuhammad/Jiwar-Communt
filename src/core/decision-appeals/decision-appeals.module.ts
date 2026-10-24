import { Global, Module } from '@nestjs/common';
import { DecisionAppeals } from './decision-appeals';

/**
 * Decision appeals (ADR 0059). Global: the gate, community and neighbours
 * register the kinds they decide, and the management decides the appeals.
 */
@Global()
@Module({ providers: [DecisionAppeals], exports: [DecisionAppeals] })
export class DecisionAppealsModule {}
