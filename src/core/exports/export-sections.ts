import { Injectable } from '@nestjs/common';
import type { AccountType } from '@prisma/client';

/** Whose data is being exported (ADR 0036): one account, one capacity. */
export interface ExportSubject {
  accountId: string;
  tenantId: string;
  accountType: AccountType;
}

/**
 * One entry of the archive: a JSON document, or one of the account's own
 * files, copied from the store by its id.
 */
export type ExportEntry =
  { path: string; json: unknown } | { path: string; fileId: string };

/**
 * A section yields its entries for the subject. It runs as the account
 * (the request context is the account's), so it reads through the same
 * services and views the account sees, each read in a short transaction of
 * its own; nothing it yields may name what those views do not show, and
 * never another person's government ID number, birth date, document image
 * or photo (ADR 0036).
 */
export type ExportSection = (
  subject: ExportSubject,
) => AsyncIterable<ExportEntry>;

/**
 * The sections of a personal-data export, by name. Domains register theirs
 * at startup, so core builds the archive without importing a domain
 * (ADR 0015).
 */
@Injectable()
export class ExportSections {
  private readonly sections = new Map<string, ExportSection>();

  register(name: string, section: ExportSection): void {
    if (this.sections.has(name))
      throw new Error(`Export section ${name} is registered twice`);
    this.sections.set(name, section);
  }

  /** In registration order. */
  all(): [string, ExportSection][] {
    return [...this.sections.entries()];
  }
}
