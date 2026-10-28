import type { Lifetime } from './timing.js';
import type { Configuration } from '../config/index.js';
import type { CommandResult, Description, Field, QueryResult } from '../types.js';
import type { CopyInput } from './copy.js';
import type { OutputStream, PortalStream } from './stream.js';

interface Rows {
  fields: readonly Field[];
  rows: object[];
  bytes: number;
  readonly arrayMode: boolean;
  readonly codecs: Configuration['codecs'];
}
type RowPhase = 'parse' | 'bind' | 'description' | 'rows' | 'ready';
type CopyPhase =
  | 'parse'
  | 'bind'
  | 'description'
  | 'copy-start'
  | 'copy-in'
  | 'copy-out'
  | 'copy-done'
  | 'copy-fail'
  | 'rows'
  | 'ready';

/** Each protocol owns only its state. Queue status and final outcome live in the envelope below. */
export type Work =
  | { kind: 'query'; phase: RowPhase; result: Rows; commit?: boolean }
  | {
      kind: 'stream';
      phase: RowPhase | 'suspended' | 'close';
      result: Rows;
      output: PortalStream;
      batchSize: number;
      metadataBytes: number;
      batchRows: number;
    }
  | {
      kind: 'script';
      phase: 'script' | 'rows' | 'ready';
      result: Rows;
      results: QueryResult<object>[];
    }
  | {
      kind: 'describe' | 'prepare';
      phase: 'parse' | 'parameters' | 'description' | 'ready';
      description: Description;
      bytes: number;
    }
  | { kind: 'statement-close'; phase: 'close' | 'ready' }
  | { kind: 'copy-from'; phase: CopyPhase; input: CopyInput; bytes: number; columns: number }
  | {
      kind: 'copy-to';
      phase: CopyPhase;
      output: OutputStream<Uint8Array>;
      bytes: number;
      columns: number;
      closedByUser?: boolean;
    };

export interface Operation {
  readonly work: Work;
  state: 'encoding' | 'queued' | 'active' | 'settled';
  wire?: Buffer;
  readonly started: number;
  readonly lifetime: Lifetime;
  readonly resolve: (operation: Operation) => void;
  readonly reject: (error: unknown) => void;
  stop: () => void;
  cleanupEnd?: number;
  stopCleanup?: () => void;
  confirmed: boolean;
  command?: CommandResult;
  error?: Error;
}
export function rows(codecs: Configuration['codecs'], arrayMode = false): Rows {
  return { fields: Object.freeze([]), rows: [], bytes: 0, arrayMode, codecs };
}
export function result(operation: Operation): QueryResult<object> {
  const work = operation.work;
  if (!('result' in work)) throw new Error('Operation has no row result.');
  return Object.freeze({
    ...operation.command!,
    rows: Object.freeze(work.result.rows),
    fields: work.result.fields,
  });
}
export function output(work: Work): OutputStream<object> | OutputStream<Uint8Array> | undefined {
  return work.kind === 'stream' || work.kind === 'copy-to' ? work.output : undefined;
}
export function bytes(work: Work, count: number): number {
  if ('result' in work) return (work.result.bytes += count);
  if ('bytes' in work) return (work.bytes += count);
  return 0;
}
export function decodeRow(
  values: readonly (Buffer | null)[],
  fields: readonly Field[],
  codecs: Configuration['codecs'],
  arrayMode: boolean,
): object {
  if (arrayMode) return values.map((value, index) => codecs.decode(value, fields[index]!));
  return Object.fromEntries(
    fields.map((field, index) => [field.name, codecs.decode(values[index]!, field)]),
  );
}
