/**
 * Markdown for one section file: the index and one block per endpoint.
 * Deterministic: the same inputs give the same bytes, so a diff of the docs is
 * a diff of the API.
 */
import type { Audience } from './audiences';
import { headerName, statusText, type Operation } from './model';
import { SAMPLE, type FieldRow, type SchemaTools } from './schema';

export const AUDIENCE_LABEL: Record<Audience, string> = {
  resident: 'Resident',
  manager: 'Manager',
  guard: 'Guard',
  technician: 'Technician',
  contractor: 'Contractor',
  partner: 'Partner',
  platform: 'Platform admin',
  public: 'Public',
};

/** Escapes what would break a table cell. */
export function cell(text: string): string {
  return text
    .replace(/\r?\n+/g, ' ')
    .replace(/(?<!\\)\|/g, '\\|')
    .trim();
}

/** GitHub's heading anchor, with its `-1`, `-2` suffix for repeats. */
export class Slugger {
  private readonly seen = new Map<string, number>();
  slug(text: string): string {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-');
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** The permission, as the short text of the index column. */
export function permissionShort(op: Operation): string {
  const r = op.route;
  if (r.platform || op.classification.basis === 'platform')
    return 'platform owner';
  if (r.public) return 'public';
  if (r.all.length) return r.all.map((p) => `\`${p}\``).join(' + ');
  if (r.any.length) {
    return r.any.length > 3
      ? `any of ${r.any.length} permissions`
      : r.any.map((p) => `\`${p}\``).join(' or ');
  }
  return 'signed-in account';
}

function permissionLines(op: Operation): string[] {
  const r = op.route;
  const c = op.classification;
  const lines: string[] = [];
  if (r.platform || c.basis === 'platform') {
    lines.push(
      '- **Permission:** platform owner. A platform token (not a compound account); sign in at `/platform/auth/login`.',
    );
    if (r.platformAllowsPasswordChange) {
      lines.push(
        '- **Note:** also accepts the restricted `password_change` token.',
      );
    }
    return lines;
  }
  if (r.public) {
    lines.push('- **Permission:** none. Public: no token, no sign-in.');
    return lines;
  }
  if (r.all.length) {
    lines.push(
      `- **Permission:** needs ${r.all.length > 1 ? 'all of: ' : ''}${r.all.map((p) => `\`${p}\``).join(', ')}`,
    );
  } else if (r.any.length) {
    if (r.any.length > 6) {
      lines.push(
        `- **Permission:** needs any one of ${r.any.length} permissions <details><summary>list</summary>${r.any.map((p) => `\`${p}\``).join(', ')}</details>`,
      );
    } else {
      lines.push(
        `- **Permission:** needs any one of: ${r.any.map((p) => `\`${p}\``).join(', ')}`,
      );
    }
  } else {
    lines.push(
      "- **Permission:** none needed. Any signed-in account (the service checks that the data is the caller's).",
    );
  }
  if (c.accountTypes.length)
    lines.push(
      `- **Account types:** ${c.accountTypes.map((t) => `\`${t}\``).join(', ')}`,
    );
  if (c.roles.length)
    lines.push(
      `- **Default roles holding it:** ${c.roles.map((t) => `\`${t}\``).join(', ')}`,
    );
  if (r.all.concat(r.any).includes('governance.board')) {
    lines.push(
      '- **Note:** `governance.board` comes from a sitting board seat, not from a role (ADR 0051).',
    );
  }
  return lines;
}

function paramTable(
  tools: SchemaTools,
  params: Operation['params']['query'],
  withRequired: boolean,
): string[] {
  const head = withRequired
    ? [
        '| Name | Type | Required | Limits | Description |',
        '|---|---|---|---|---|',
      ]
    : ['| Name | Type | Description |', '|---|---|---|'];
  const rows = params.map((p) => {
    const type = tools.typeLabel(p.schema);
    const limits = tools.limits(p.schema);
    const desc = cell(
      p.description ?? tools.resolve(p.schema).description ?? '',
    );
    return withRequired
      ? `| \`${headerName2(p.name, p.in)}\` | ${type} | ${p.required ? 'yes' : 'no'} | ${cell(limits)} | ${desc} |`
      : `| \`${p.name}\` | ${type} | ${desc} |`;
  });
  return [...head, ...rows];
}

function headerName2(name: string, where: string): string {
  return where === 'header' ? headerName(name) : name;
}

function fieldTable(rows: FieldRow[], requiredLabel: string): string[] {
  if (rows.length === 0) return [];
  const out = [
    `| Field | Type | ${requiredLabel} | Limits | Notes |`,
    '|---|---|---|---|---|',
  ];
  for (const r of rows) {
    out.push(
      `| \`${r.path}\` | ${r.type} | ${r.required ? 'yes' : 'no'} | ${cell(r.limits)} | ${cell(r.description)} |`,
    );
  }
  return out;
}

/** Path with `{name}` replaced by a placeholder, for the request example. */
function examplePath(op: Operation): string {
  let p = op.fullPath;
  for (const param of op.params.path) {
    const placeholder = /id$/i.test(param.name)
      ? SAMPLE.uuid
      : `<${param.name}>`;
    p = p.replace(`{${param.name}}`, placeholder);
  }
  return p;
}

function requestExample(tools: SchemaTools, op: Operation): string[] {
  const query = op.params.query.filter((q) => q.required);
  const qs = query.length
    ? '?' +
      query
        .map(
          (q) =>
            `${q.name}=${encodeURIComponent(String(tools.example(q.schema)))}`,
        )
        .join('&')
    : '';
  const lines = [`${op.method.toUpperCase()} ${examplePath(op)}${qs}`];
  if (op.route.platform)
    lines.push('Authorization: Bearer <platformAccessToken>');
  else if (!op.route.public) lines.push('Authorization: Bearer <accessToken>');
  if (op.idempotencyKey) lines.push('Idempotency-Key: <uuid>');
  for (const h of op.params.header) {
    lines.push(`${headerName(h.name)}: <${h.name}>`);
  }
  if (op.body) {
    lines.push(`Content-Type: ${op.body.contentType}`, '');
    lines.push(json(tools.example(op.body.schema)));
  }
  return ['```http', ...lines, '```'];
}

export function renderOperation(tools: SchemaTools, op: Operation): string {
  const out: string[] = [];
  out.push(`### ${op.summary}`, '');
  out.push('```http', `${op.method.toUpperCase()} ${op.fullPath}`, '```', '');
  out.push(...permissionLines(op));
  const headers: string[] = [];
  if (op.route.platform)
    headers.push('`Authorization: Bearer <platformAccessToken>`');
  else if (!op.route.public)
    headers.push('`Authorization: Bearer <accessToken>`');
  if (op.idempotencyKey) {
    headers.push(
      '`Idempotency-Key: <uuid>` (optional: a retry with the same key within 24 h returns the first answer)',
    );
  }
  for (const h of op.params.header)
    headers.push(`\`${headerName(h.name)}\`${h.required ? '' : ' (optional)'}`);
  out.push(`- **Headers:** ${headers.length ? headers.join('; ') : 'none'}`);
  out.push(
    `- **Idempotency-Key:** ${op.idempotencyKey ? 'accepted' : 'not used'}`,
  );
  if (op.noStore)
    out.push('- **Cache:** the response is `no-store`: do not cache it');
  out.push('');
  if (op.description) out.push(op.description, '');

  // Request
  out.push('#### Request', '');
  let anyInput = false;
  if (op.params.path.length) {
    anyInput = true;
    out.push(
      '**Path params**',
      '',
      ...paramTable(tools, op.params.path, false),
      '',
    );
  }
  if (op.params.query.length) {
    anyInput = true;
    out.push(
      '**Query params**',
      '',
      ...paramTable(tools, op.params.query, true),
      '',
    );
  }
  if (op.params.header.length) {
    anyInput = true;
    out.push(
      '**Header params**',
      '',
      ...paramTable(tools, op.params.header, true),
      '',
    );
  }
  if (op.body) {
    anyInput = true;
    const schemaName = tools.resolve(op.body.schema).name;
    out.push(
      `**Body** (\`${op.body.contentType}\`${schemaName ? `, \`${schemaName}\`` : ''}${op.body.required ? '' : ', optional'})`,
      '',
    );
    const rows = tools.rows(op.body.schema);
    if (rows.length) out.push(...fieldTable(rows, 'Required'), '');
  }
  if (!anyInput) out.push('No path, query or body parameters.', '');
  out.push('**Example**', '', ...requestExample(tools, op), '');

  // Response
  out.push('#### Response', '');
  for (const r of op.responses) {
    const label = `**${r.status}** ${statusText(r.status)}`.trim();
    if (!r.contentType) {
      out.push(`${label}: no body.`, '');
      continue;
    }
    const schemaName = r.schema ? tools.resolve(r.schema).name : undefined;
    out.push(
      `${label} (\`${r.contentType}\`${schemaName ? `, \`${schemaName}\`` : ''})`,
      '',
    );
    if (r.contentType.includes('json')) {
      out.push('```json', json(tools.example(r.schema)), '```', '');
      const rows = tools.rows(r.schema);
      if (rows.length) {
        out.push(
          '<details><summary>Fields</summary>',
          '',
          ...fieldTable(rows, 'Always present'),
          '',
          '</details>',
          '',
        );
      }
    } else {
      out.push(`The response is a file (\`${r.contentType}\`).`, '');
    }
  }

  // Errors
  if (op.errors.length) {
    out.push('#### Errors', '', '| Status | Code | When |', '|---|---|---|');
    for (const e of op.errors)
      out.push(`| ${e.status} | \`${e.code}\` | ${cell(e.when)} |`);
    out.push('');
  }
  out.push('---', '');
  return out.join('\n');
}

export interface SectionDoc {
  audience: Audience;
  number: string;
  slug: string;
  title: string;
  blurb: string;
  notes: string[];
  ops: Operation[];
  sha: string;
}

export function renderSection(tools: SchemaTools, doc: SectionDoc): string {
  const out: string[] = [];
  out.push(
    `<!-- Generated by \`pnpm api-docs\` from main@${doc.sha}. Do not edit by hand. -->`,
    '',
  );
  out.push(`# ${doc.title}`, '');
  out.push(doc.blurb, '');
  out.push(
    `**${doc.ops.length} endpoint${doc.ops.length === 1 ? '' : 's'}** for the ${AUDIENCE_LABEL[doc.audience].toLowerCase()} audience. Source: main \`${doc.sha.slice(0, 8)}\`. The basics (sign-in, headers, errors, pagination, file upload) are in the [README](README.md).`,
    '',
  );
  if (doc.notes.length) {
    out.push(
      `Design notes: ${doc.notes.map((n) => `[${n.replace(/\.md$/, '')}](../notes/${n})`).join(', ')}.`,
      '',
    );
  }

  // The index links to the headings below, so build the anchors in order.
  const slugger = new Slugger();
  for (const heading of [doc.title, 'Index', 'Endpoints'])
    slugger.slug(heading);
  const anchors = doc.ops.map((op) => slugger.slug(op.summary));
  out.push(
    '## Index',
    '',
    '| Method | Path | Description | Permission |',
    '|---|---|---|---|',
  );
  doc.ops.forEach((op, i) => {
    out.push(
      `| ${op.method.toUpperCase()} | \`${op.path}\` | [${cell(op.summary)}](#${anchors[i]}) | ${permissionShort(op)} |`,
    );
  });
  out.push('', '## Endpoints', '');
  for (const op of doc.ops) out.push(renderOperation(tools, op));
  return out.join('\n');
}
