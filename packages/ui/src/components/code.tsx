import { Fragment, useMemo, useState } from 'react';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { cn } from '../lib/cn';

/**
 * JSON rendering for the OCPP frame inspector.
 *
 * This is the component the whole log screen exists for, so it gets more care
 * than a `<pre>{JSON.stringify(x, null, 2)}</pre>`:
 *
 *  - Types are coloured so a string "2" and a number 2 are visibly different.
 *    That distinction matters constantly in OCPP, where meter readings arrive
 *    as strings and transaction ids are numbers in 1.6 and strings in 2.0.1.
 *  - Objects and arrays collapse, because a MeterValues payload is four levels
 *    deep and you usually want one branch.
 *  - Keys you name are highlighted, so "the field that is wrong" can be
 *    pointed at directly from a validation error.
 */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface JsonViewProps {
  value: unknown;
  /** Levels expanded on first render. */
  defaultExpandDepth?: number;
  /** Dotted paths to highlight, e.g. ["idTagInfo.status"]. */
  highlight?: string[];
  className?: string;
}

export function JsonView({ value, defaultExpandDepth = 3, highlight = [], className }: JsonViewProps) {
  const highlightSet = useMemo(() => new Set(highlight), [highlight]);
  return (
    <div className={cn('font-mono text-[11.5px] leading-[1.75]', className)}>
      <JsonNode
        value={value as Json}
        name={null}
        path=""
        depth={0}
        defaultExpandDepth={defaultExpandDepth}
        highlight={highlightSet}
        isLast
      />
    </div>
  );
}

function JsonNode({
  value,
  name,
  path,
  depth,
  defaultExpandDepth,
  highlight,
  isLast,
}: {
  value: Json;
  name: string | null;
  path: string;
  depth: number;
  defaultExpandDepth: number;
  highlight: Set<string>;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(depth < defaultExpandDepth);
  const isObject = value !== null && typeof value === 'object';
  const isArray = Array.isArray(value);
  const marked = highlight.has(path);

  const key = name !== null && (
    <>
      <span className={cn(marked ? 'rounded-[3px] bg-warn-soft px-1 text-warn' : 'text-ink-2')}>
        &quot;{name}&quot;
      </span>
      <span className="text-ink-3">: </span>
    </>
  );

  if (!isObject) {
    return (
      <div style={{ paddingLeft: depth * 14 }}>
        {key}
        <JsonScalar value={value} />
        {!isLast && <span className="text-ink-3">,</span>}
      </div>
    );
  }

  const entries: Array<[string, Json]> = isArray
    ? (value as Json[]).map((v, i) => [String(i), v])
    : Object.entries(value as { [k: string]: Json });
  const openBrace = isArray ? '[' : '{';
  const closeBrace = isArray ? ']' : '}';

  return (
    <div>
      <div style={{ paddingLeft: depth * 14 }} className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? `Collapse ${name ?? 'root'}` : `Expand ${name ?? 'root'}`}
          className="-ml-3.5 mr-0.5 grid size-3.5 shrink-0 place-items-center rounded-[3px] text-ink-3 hover:bg-surface-3 hover:text-ink-1"
        >
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
        {key}
        <span className="text-ink-3">{openBrace}</span>
        {!open && (
          <>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mx-1 rounded-[3px] bg-surface-3 px-1.5 text-[10px] text-ink-3 hover:text-ink-1"
            >
              {entries.length} {entries.length === 1 ? 'item' : 'items'}
            </button>
            <span className="text-ink-3">
              {closeBrace}
              {!isLast && ','}
            </span>
          </>
        )}
      </div>

      {open && (
        <>
          {entries.map(([k, v], i) => (
            <Fragment key={k}>
              <JsonNode
                value={v}
                name={isArray ? null : k}
                path={path ? `${path}.${k}` : k}
                depth={depth + 1}
                defaultExpandDepth={defaultExpandDepth}
                highlight={highlight}
                isLast={i === entries.length - 1}
              />
            </Fragment>
          ))}
          <div style={{ paddingLeft: depth * 14 }} className="text-ink-3">
            {closeBrace}
            {!isLast && ','}
          </div>
        </>
      )}
    </div>
  );
}

function JsonScalar({ value }: { value: Json }) {
  if (value === null) return <span className="text-violet">null</span>;
  switch (typeof value) {
    case 'string':
      return <span className="text-accent">&quot;{value}&quot;</span>;
    case 'number':
      return <span className="text-info tabular">{value}</span>;
    case 'boolean':
      return <span className="text-violet">{String(value)}</span>;
    default:
      return <span className="text-ink-2">{String(value)}</span>;
  }
}

/* ------------------------------------------------------------------ *
 * CodeBlock
 * ------------------------------------------------------------------ */

export interface CodeBlockProps {
  code: string;
  label?: string;
  /** Adds a copy button. */
  copyable?: boolean;
  wrap?: boolean;
  className?: string;
}

export function CodeBlock({ code, label, copyable = true, wrap, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard is blocked in some embedded contexts. Failing quietly is
      // right here — the text is still selectable.
    }
  }

  return (
    <div className={cn('overflow-hidden rounded-sm border border-line-soft bg-surface-2', className)}>
      {(label || copyable) && (
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5">
          {label && (
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              {label}
            </span>
          )}
          {copyable && (
            <button
              type="button"
              onClick={copy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xs px-1.5 py-0.5 text-[11px] text-ink-3 hover:bg-surface-3 hover:text-ink-1"
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
        </div>
      )}
      <pre
        className={cn(
          'm-0 overflow-x-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.7] text-ink-2',
          wrap && 'whitespace-pre-wrap break-all',
        )}
      >
        {code}
      </pre>
    </div>
  );
}
