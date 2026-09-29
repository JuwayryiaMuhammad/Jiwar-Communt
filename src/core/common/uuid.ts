import { v7 } from 'uuid';

/** App-generated, time-ordered primary keys (ADR 0006). */
export const newId = (): string => v7();
