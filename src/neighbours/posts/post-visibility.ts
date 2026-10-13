import { Injectable } from '@nestjs/common';

/**
 * Whose posts a resident does not see on the boards (ADR 0042): nobody's,
 * until masked contact brings blocks. Kept apart so the board never has to
 * know why an author is hidden.
 */
@Injectable()
export class PostVisibility {
  /** The accounts whose posts the caller must not see. */
  hiddenAuthors(): Promise<string[]> {
    return Promise.resolve([]);
  }
}
