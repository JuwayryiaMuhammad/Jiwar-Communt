import { Injectable } from '@nestjs/common';
import type {
  ChecklistAnswer,
  ChecklistAnswerPhoto,
  ChecklistRun,
  ChecklistTemplateItem,
} from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import { AssetReadings } from './asset-readings.service';
import {
  answered,
  answerOf,
  attestation,
  PHOTOS_PER_ANSWER,
  type AnswerInput,
  type ItemKind,
} from './checklist-rules';

export interface RunAnswerRead {
  answer: ChecklistAnswer;
  photos: { photo: ChecklistAnswerPhoto; read: PresignedRead | null }[];
}

export interface RunRead {
  run: ChecklistRun;
  items: { item: ChecklistTemplateItem; answer: RunAnswerRead | null }[];
}

/** What a submission found: the failing items that ask for a follow-up. */
export interface Submitted {
  run: ChecklistRun;
  failed: ChecklistTemplateItem[];
}

const runNotFound = () =>
  appError.notFound(ErrorCode.CHECKLIST_RUN_NOT_FOUND, 'Checklist not found');

/**
 * A checklist being filled (ADR 0064): opened on a ticket's cycle or an
 * inspection, of the template's current version; answered item by item
 * while open; submitted once, when every required item is answered, with
 * the SHA-256 of what it says. The caller holds the subject's lock (the
 * ticket, the inspection) and the run's (`lock`), in that order, so two
 * answers or an answer and the submission never pass each other; the
 * database refuses any change to a submitted run's answers besides.
 */
@Injectable()
export class ChecklistRuns {
  constructor(
    private readonly ctx: RequestContext,
    private readonly files: FilesService,
    private readonly readings: AssetReadings,
  ) {}

  async open(
    tx: TenantTxClient,
    input: {
      tenantId: string;
      templateId: string;
      ticketId?: string;
      cycle?: number;
      inspectionId?: string;
      assetId: string | null;
    },
  ): Promise<ChecklistRun> {
    const template = await tx.checklistTemplate.findUniqueOrThrow({
      where: { id: input.templateId },
    });
    return tx.checklistRun.create({
      data: {
        id: newId(),
        tenantId: input.tenantId,
        templateId: template.id,
        version: template.currentVersion,
        ticketId: input.ticketId ?? null,
        cycle: input.cycle ?? null,
        inspectionId: input.inspectionId ?? null,
        assetId: input.assetId,
        createdAt: await dbNow(tx),
      },
    });
  }

  /** A ticket's run of a cycle, locked for update, or null. */
  async lockOfTicket(
    tx: TenantTxClient,
    ticketId: string,
    cycle: number,
  ): Promise<ChecklistRun | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM checklist_runs
       WHERE ticket_id = ${ticketId}::uuid AND cycle = ${cycle}
         FOR UPDATE`;
    return row
      ? tx.checklistRun.findUniqueOrThrow({ where: { id: row.id } })
      : null;
  }

  /** An inspection's run, locked for update. */
  async lockOfInspection(
    tx: TenantTxClient,
    inspectionId: string,
  ): Promise<ChecklistRun> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM checklist_runs WHERE inspection_id = ${inspectionId}::uuid FOR UPDATE`;
    if (!row) throw runNotFound();
    return tx.checklistRun.findUniqueOrThrow({ where: { id: row.id } });
  }

  /** A ticket's run of a cycle, or null (no lock: a read). */
  ofTicket(
    tx: TenantTxClient,
    ticketId: string,
    cycle: number,
  ): Promise<ChecklistRun | null> {
    return tx.checklistRun.findFirst({ where: { ticketId, cycle } });
  }

  /** A run's items with their answers and photos (presigned). */
  async read(tx: TenantTxClient, run: ChecklistRun): Promise<RunRead> {
    const items = await tx.checklistTemplateItem.findMany({
      where: { templateId: run.templateId, version: run.version },
      orderBy: { position: 'asc' },
    });
    const answers = await tx.checklistAnswer.findMany({
      where: { runId: run.id },
    });
    const photos = await tx.checklistAnswerPhoto.findMany({
      where: { answerId: { in: answers.map((a) => a.id) } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const out: RunRead['items'] = [];
    for (const item of items) {
      const answer = answers.find((a) => a.itemId === item.id);
      if (!answer) {
        out.push({ item, answer: null });
        continue;
      }
      const mine: RunAnswerRead['photos'] = [];
      for (const photo of photos.filter((p) => p.answerId === answer.id))
        mine.push({ photo, read: await this.files.readUrl(tx, photo.fileId) });
      out.push({ item, answer: { answer, photos: mine } });
    }
    return { run, items: out };
  }

  /**
   * Answers one item of an open run (the caller locked it): its result,
   * value or note replaced, its photos added (three at most).
   */
  async answer(
    tx: TenantTxClient,
    run: ChecklistRun,
    itemId: string,
    input: AnswerInput & { photoFileIds?: string[] },
  ): Promise<void> {
    if (run.status !== 'open')
      throw appError.conflict(
        ErrorCode.CHECKLIST_RUN_SUBMITTED,
        'This checklist is submitted',
      );
    const item = await tx.checklistTemplateItem.findFirst({
      where: { id: itemId, templateId: run.templateId, version: run.version },
    });
    if (!item)
      throw appError.notFound(
        ErrorCode.CHECKLIST_ITEM_NOT_FOUND,
        'Checklist item not found',
      );
    const { result, value, problems } = answerOf(
      {
        kind: item.kind as ItemKind,
        minValue: item.minValue,
        maxValue: item.maxValue,
      },
      input,
    );
    if (problems.length)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid answer', {
        fields: problems,
      });
    const now = await dbNow(tx);
    const note = input.note?.trim() || null;
    const saved = await tx.checklistAnswer.upsert({
      where: { runId_itemId: { runId: run.id, itemId } },
      create: {
        id: newId(),
        tenantId: run.tenantId,
        runId: run.id,
        itemId,
        result,
        value,
        note,
        answeredById: this.ctx.accountId,
        answeredAt: now,
      },
      update: {
        result,
        value,
        note,
        answeredById: this.ctx.accountId,
        answeredAt: now,
      },
    });
    const adding = input.photoFileIds ?? [];
    if (!adding.length) return;
    const had = await tx.checklistAnswerPhoto.count({
      where: { answerId: saved.id },
    });
    if (had + adding.length > PHOTOS_PER_ANSWER)
      throw appError.conflict(
        ErrorCode.CHECKLIST_PHOTO_LIMIT_REACHED,
        'No more photos on this answer',
        { params: { max: PHOTOS_PER_ANSWER } },
      );
    for (const [i, fileId] of adding.entries()) {
      const file = await this.files.claim(tx, fileId, 'checklist_photo');
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Invalid answer',
          {
            fields: [
              {
                field: `photoFileIds.${i}`,
                code: FieldErrorCode.FILE_NOT_AVAILABLE,
              },
            ],
          },
        );
      await this.files.attach(tx, file);
      await tx.checklistAnswerPhoto.create({
        data: {
          id: newId(),
          tenantId: run.tenantId,
          answerId: saved.id,
          fileId: file.id,
          createdAt: now,
        },
      });
    }
  }

  /**
   * Submits an open run (the caller locked it): every required item
   * answered (409 CHECKLIST_INCOMPLETE, `params.positions`), the
   * attestation written, the readings recorded for its asset. Returns the
   * failing items that ask for a follow-up; opening them is the caller's.
   */
  async submit(tx: TenantTxClient, run: ChecklistRun): Promise<Submitted> {
    if (run.status !== 'open')
      throw appError.conflict(
        ErrorCode.CHECKLIST_RUN_SUBMITTED,
        'This checklist is submitted',
      );
    const { items } = await this.read(tx, run);
    const missing = items
      .filter(
        ({ item, answer }) =>
          item.required &&
          !answered(
            item.kind as ItemKind,
            answer
              ? {
                  result: answer.answer.result,
                  value: answer.answer.value,
                  note: answer.answer.note,
                  photos: answer.photos.length,
                }
              : undefined,
          ),
      )
      .map(({ item }) => item.position);
    if (missing.length)
      throw appError.conflict(
        ErrorCode.CHECKLIST_INCOMPLETE,
        'Some required items are not answered',
        {
          params: { positions: missing },
        },
      );
    const now = await dbNow(tx);
    const me = this.ctx.accountId;
    const hash = attestation({
      runId: run.id,
      templateId: run.templateId,
      version: run.version,
      submittedById: me,
      submittedAt: now,
      answers: items
        .filter(({ answer }) => answer !== null)
        .map(({ item, answer }) => ({
          itemId: item.id,
          position: item.position,
          result: answer!.answer.result,
          value: answer!.answer.value?.toFixed(4) ?? null,
          note: answer!.answer.note,
          photoFileIds: answer!.photos.map((p) => p.photo.fileId),
        })),
    });
    const submitted = await tx.checklistRun.update({
      where: { id: run.id },
      data: {
        status: 'submitted',
        submittedAt: now,
        submittedById: me,
        attestationSha256: hash,
      },
    });
    if (run.assetId !== null)
      await this.readings.record(
        tx,
        items
          .filter(
            ({ item, answer }) =>
              item.kind === 'reading' && answer?.answer.value != null,
          )
          .map(({ item, answer }) => ({
            tenantId: run.tenantId,
            assetId: run.assetId!,
            metricKey: item.metricKey!,
            value: answer!.answer.value!.toFixed(4),
            unit: item.unit,
            source: 'run' as const,
            runId: run.id,
            recordedById: me,
            occurredAt: now,
            recordedAt: now,
          })),
      );
    const failed = items
      .filter(
        ({ item, answer }) =>
          item.failCreatesTicket && answer?.answer.result === 'fail',
      )
      .map(({ item }) => item);
    return { run: submitted, failed };
  }

  async lock(tx: TenantTxClient, runId: string): Promise<ChecklistRun> {
    await tx.$queryRaw`SELECT id FROM checklist_runs WHERE id = ${runId}::uuid FOR UPDATE`;
    const run = await tx.checklistRun.findUnique({ where: { id: runId } });
    if (!run) throw runNotFound();
    return run;
  }
}

export { runNotFound };
