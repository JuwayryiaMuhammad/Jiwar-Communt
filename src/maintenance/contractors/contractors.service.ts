import { Injectable } from '@nestjs/common';
import type {
  MaintenanceContract,
  MaintenanceContractPayment,
  Prisma,
  Vendor,
} from '@prisma/client';
import { AccountRecord } from '../../core/accounts/account-record';
import { AccountWriter } from '../../core/accounts/account-writer';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { VendorsService, vendorNotFound } from '../vendors/vendors.service';
import { ContractorAccess } from './contractor-access';

export interface NewContractor {
  fullName: string;
  idDocumentType: 'national_id' | 'passport';
  idDocumentNumber: string;
  nationality?: string;
  birthDate?: string;
  phone: string;
  email: string;
}

const PAGE = keysetCursor('createdAt', 'asc');

/**
 * A vendor's contractor accounts (ADR 0088), kept with `vendors.manage` on
 * the vendor's page: the manager invites them as they invite staff (the
 * account and its login identifiers together, ADR 0003; the role
 * `contractor`), and deactivates them through the accounts' own route.
 * A suspended vendor takes no new contractor. A contractor stays its
 * vendor's: another vendor's work is another account (same email, same
 * phone: one login, two capacities, ADR 0002).
 */
@Injectable()
export class ContractorsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly writer: AccountWriter,
    private readonly vendors: VendorsService,
    private readonly access: ContractorAccess,
  ) {}

  /** Invites one: the vendor shared-locked so it is not suspended meanwhile. */
  add(vendorId: string, input: NewContractor): Promise<AccountRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.vendors.lockUsable(tx, vendorId);
      const account = await this.writer.create(tx, this.ctx.tenantId, {
        type: 'contractor',
        vendorId,
        fullName: input.fullName,
        idDocumentType: input.idDocumentType,
        idDocumentNumber: input.idDocumentNumber,
        nationality: input.nationality,
        birthDate: input.birthDate,
        phone: input.phone,
        email: input.email,
      });
      return AccountRecord.from(account);
    });
  }

  /** The vendor's contractors, oldest first, every status. */
  list(
    vendorId: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<AccountRecord>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await tx.vendor.findUnique({ where: { id: vendorId } })))
        throw vendorNotFound();
      const rows = await tx.account.findMany({
        where: {
          AND: [
            { vendorId, type: 'contractor' },
            ...(PAGE.after(q.cursor) as Prisma.AccountWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: page.items.map((a) => AccountRecord.from(a)),
        nextCursor: page.nextCursor,
      };
    });
  }

  /**
   * The vendor's contracts, by end date, with their payment schedules: what
   * a contractor bills against (ADR 0088). Codes, dates, amounts and whether
   * each payment is paid; never the compound's notes or approvals.
   */
  myContracts(): Promise<
    (MaintenanceContract & { payments: MaintenanceContractPayment[] })[]
  > {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vendorId = await this.access.vendorOf(tx);
      return tx.maintenanceContract.findMany({
        where: { vendorId, terminatedAt: null },
        include: {
          payments: { orderBy: [{ dueOn: 'asc' }, { id: 'asc' }] },
        },
        orderBy: [{ endsOn: 'desc' }, { id: 'asc' }],
        take: 100,
      });
    });
  }

  /** The contractor's own vendor, as its app shows it. */
  myVendor(): Promise<Vendor> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const vendorId = await this.access.vendorOf(tx);
      return tx.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    });
  }
}
