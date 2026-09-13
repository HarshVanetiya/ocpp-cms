/**
 * Generates the OCPP message reference in `docs/01-ocpp-primer/` from the
 * catalogue in `src/`.
 *
 * Run: npm run docs:reference
 *
 * Why generate rather than write it twice: the catalogue is already the thing
 * the log inspector reads at runtime. Hand-copying 60 messages into markdown
 * guarantees the two drift, and the drift is invisible until someone trusts
 * the wrong one.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageDoc } from '../src/types';
import { OCPP16_MESSAGES } from '../src/ocpp16';
import { OCPP201_MESSAGES } from '../src/ocpp201';
import { comparisonRows } from '../src/index';

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, '../../../docs/01-ocpp-primer');

const GROUPING_LABEL: Record<string, string> = {
  core: 'Core',
  provisioning: 'Provisioning',
  authorization: 'Authorization',
  availability: 'Availability',
  transactions: 'Transactions',
  meter_values: 'Meter values',
  remote_trigger: 'Remote trigger',
  reservation: 'Reservation',
  smart_charging: 'Smart charging',
  local_auth_list: 'Local authorisation list',
  firmware_management: 'Firmware management',
  device_management: 'Device management',
  diagnostics: 'Diagnostics',
  display_message: 'Display messages',
  data_transfer: 'Data transfer',
  security: 'Security',
  tariff_cost: 'Tariff and cost',
  iso15118: 'ISO 15118 / Plug & Charge',
};

const ORIGIN_LABEL: Record<string, string> = {
  cp_to_csms: 'Station → CSMS',
  csms_to_cp: 'CSMS → Station',
  both: 'Either direction',
};

/** Markdown table cells cannot contain a raw pipe or a newline. */
function cell(text: string) {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

function anchor(action: string) {
  return action.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function renderMessage(doc: MessageDoc): string {
  const lines: string[] = [];
  lines.push(`### ${doc.action}`);
  lines.push('');
  lines.push(
    `**${ORIGIN_LABEL[doc.origin]}** · ${GROUPING_LABEL[doc.grouping] ?? doc.grouping}` +
      (doc.core ? ' · required for a conformant implementation' : '') +
      ` · introduced in Milestone ${doc.milestone}`,
  );
  lines.push('');
  lines.push(doc.detail);
  lines.push('');
  lines.push(`**When it fires.** ${doc.whenItFires}`);
  lines.push('');

  for (const [label, fields] of [
    ['Request', doc.requestFields],
    ['Response', doc.responseFields],
  ] as const) {
    if (fields.length === 0) {
      lines.push(`**${label}.** Empty.`);
      lines.push('');
      continue;
    }
    lines.push(`**${label} fields**`);
    lines.push('');
    lines.push('| Field | Type | Required | Meaning |');
    lines.push('|---|---|---|---|');
    for (const f of fields) {
      const values = f.values ? `<br>*One of:* \`${f.values.join('`, `')}\`` : '';
      lines.push(
        `| \`${cell(f.name)}\` | ${cell(f.type)} | ${f.required ? 'yes' : 'no'} | ${cell(f.description)}${values} |`,
      );
    }
    lines.push('');
    for (const f of fields) {
      if (!f.gotcha) continue;
      lines.push(`> **Watch out — \`${f.name}\`.** ${f.gotcha}`);
      lines.push('');
    }
  }

  if (doc.counterpart) {
    lines.push(`**Equivalent in the other version:** \`${doc.counterpart}\``);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

function renderVersion(
  title: string,
  intro: string,
  messages: MessageDoc[],
  outFile: string,
) {
  const byGroup = new Map<string, MessageDoc[]>();
  for (const m of messages) {
    const list = byGroup.get(m.grouping) ?? [];
    list.push(m);
    byGroup.set(m.grouping, list);
  }

  const lines: string[] = [];
  lines.push(`# ${title}`);
  lines.push('');
  lines.push('<!-- GENERATED FILE — edit packages/ocpp/src, then run `npm run docs:reference`. -->');
  lines.push('');
  lines.push(intro);
  lines.push('');
  lines.push('## Every message at a glance');
  lines.push('');
  lines.push('| Message | Direction | Group | Core | What it is for |');
  lines.push('|---|---|---|---|---|');
  for (const m of messages) {
    lines.push(
      `| [\`${m.action}\`](#${anchor(m.action)}) | ${ORIGIN_LABEL[m.origin]} | ${GROUPING_LABEL[m.grouping] ?? m.grouping} | ${m.core ? '●' : '○'} | ${cell(m.summary)} |`,
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const [group, list] of byGroup) {
    lines.push(`## ${GROUPING_LABEL[group] ?? group}`);
    lines.push('');
    for (const m of list) lines.push(renderMessage(m));
  }

  mkdirSync(docsDir, { recursive: true });
  writeFileSync(resolve(docsDir, outFile), lines.join('\n'));
  console.log(`wrote ${outFile} — ${messages.length} messages`);
}

renderVersion(
  'OCPP 1.6J message reference',
  [
    'Every message this project handles, what it means, and the specific thing',
    'in each one that will cost you an afternoon.',
    '',
    'A **core** message (●) is one a minimally conformant CSMS must implement.',
    'The rest are optional profiles that real hardware may or may not support —',
    'and which a station advertises through the `SupportedFeatureProfiles`',
    'configuration key.',
    '',
    'New to the protocol? Read [the primer](README.md) first.',
  ].join('\n'),
  OCPP16_MESSAGES,
  'ocpp-1.6.md',
);

renderVersion(
  'OCPP 2.0.1 message reference',
  [
    'OCPP 2.0.1 is not "1.6 with more messages". Four structural changes explain',
    'almost everything that looks unfamiliar:',
    '',
    '1. **Transactions became one message.** `StartTransaction`,',
    '   `StopTransaction` and `MeterValues` collapsed into `TransactionEvent`,',
    '   and the **station** now allocates the transaction id instead of you.',
    '2. **The device model replaced configuration keys.** A flat bag of strings',
    '   became a tree of components and typed variables you can query.',
    '3. **Security moved into the core specification** — certificates, security',
    '   profiles and a security event log, rather than an optional whitepaper.',
    '4. **ISO 15118 support** — Plug & Charge, where the car identifies itself',
    '   over the cable and no card or app is needed.',
    '',
    'The RPC framing is unchanged, which is why one gateway can serve both',
    'versions: only the payloads and action names differ.',
    '',
    'See also [the side-by-side comparison](comparing-versions.md).',
  ].join('\n'),
  OCPP201_MESSAGES,
  'ocpp-2.0.1.md',
);

/* ------------------------------------------------------------------ *
 * Comparison table
 * ------------------------------------------------------------------ */

const cmp: string[] = [];
cmp.push('# OCPP 1.6 vs 2.0.1, side by side');
cmp.push('');
cmp.push('<!-- GENERATED FILE — edit packages/ocpp/src, then run `npm run docs:reference`. -->');
cmp.push('');
cmp.push(
  [
    'The table people actually want. Every row is one concept and what it is',
    'called in each version.',
    '',
    'This is also the table to have in your head walking into an interview: being',
    'able to say *"RemoteStartTransaction became RequestStartTransaction, because',
    'the station decides whether to honour it"* demonstrates that you have read',
    'the specifications rather than a blog post about them.',
  ].join('\n'),
);
cmp.push('');
cmp.push('| Concept | OCPP 1.6J | OCPP 2.0.1 | Why it changed |');
cmp.push('|---|---|---|---|');
for (const row of comparisonRows()) {
  cmp.push(
    `| ${cell(row.concept)} | ${row.ocpp16 ? `\`${cell(row.ocpp16)}\`` : '—'} | ${row.ocpp201 ? `\`${cell(row.ocpp201)}\`` : '—'} | ${cell(row.note)} |`,
  );
}
cmp.push('');
cmp.push('---');
cmp.push('');
cmp.push('## How this project supports both at once');
cmp.push('');
cmp.push(
  [
    'One canonical model, translated at the edge. The WebSocket gateway is the',
    'only place in the whole system that knows the words `StartTransaction` or',
    '`TransactionEvent`; everything above it — the database, the REST API, the',
    'dashboard — speaks one vocabulary.',
    '',
    'The translation lives in two files worth reading:',
    '',
    '- [`packages/contracts/src/enums.ts`](../../packages/contracts/src/enums.ts)',
    '  — the canonical vocabulary, with the mapping rules written out.',
    '- [`packages/ocpp/src/mapping.ts`](../../packages/ocpp/src/mapping.ts)',
    '  — the pure functions that do the translating.',
    '',
    'The hardest single mapping is connector status, because 2.0.1 deliberately',
    'shrank the list from nine values to five and moved the detail into the',
    'transaction:',
    '',
    '```',
    '  1.6  StatusNotification.status = "Charging"        → charging',
    '',
    '2.0.1  StatusNotification.connectorStatus = "Occupied"',
    '       + TransactionEvent.chargingState  = "Charging" → charging',
    '                                         = "SuspendedEV" → suspended_ev',
    '                                         = "EVConnected"  → preparing',
    '```',
    '',
    'You need **both** messages to know what a 2.0.1 connector is doing. That',
    'asymmetry is the clearest example of 2.0.1 separating "what is the socket',
    'doing" from "what is the transaction doing", and it is a very good thing to',
    'be able to explain out loud.',
  ].join('\n'),
);
writeFileSync(resolve(docsDir, 'comparing-versions.md'), cmp.join('\n'));
console.log('wrote comparing-versions.md');
