import { DEFAULT_TEMP_C } from '@gmid/mostab-core';
// Local persistence for loaded device tables — IndexedDB, because a characterization
// grid (megabytes of Float64Array) is far past localStorage budgets and structured
// clone stores Maps and typed arrays natively. Client-only like everything else: the
// data never leaves the machine. Only a table the user chose to keep across reloads is
// written here; a session-only table lives in memory and is never passed to putTable.
// Every stored table has a visible chip in the devices strip (marked stored, with a
// control that turns it session-only and deletes the stored copy), the strip lists what
// is stored with its size and import date, and clear-all wipes the store — so what is
// retained is always inspectable and deletable. Storage failures never throw: blocked
// or unavailable storage (private mode, some file:// contexts) degrades to in-memory
// only, and the write and delete calls report whether they took effect so the page can
// say so instead of showing a table as stored when it is not.

import type { DeviceTable } from '@gmid/mostab-core';

const DB = 'gmid';
const STORE = 'tables';

/**
 * What one stored record holds: the table and when it was imported (ms since the epoch).
 * Records written before the date was kept are the bare DeviceTable; both shapes are read
 * back (see unwrap), and a bare one simply has no import date.
 */
interface StoredRecord {
  v: 1;
  table: DeviceTable;
  importedAt?: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promisify one IndexedDB request. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Settles when the transaction commits; rejects when it aborts. A write is only on disk once
 *  its transaction completes — a request can succeed and its transaction still abort (a quota
 *  error is reported that way). */
function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}

async function txn<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, mode);
    // Both are awaited together so neither rejection goes unhandled.
    const [result] = await Promise.all([req(run(tx.objectStore(STORE))), committed(tx)]);
    return result;
  } finally {
    db.close();
  }
}

// Writes run one after another in the order they were asked for. Each opens its own
// connection, and without this a delete asked for after a put (a table imported, then
// turned session-only at once) could commit first and leave the stored copy behind.
let writes: Promise<unknown> = Promise.resolve();
function inOrder(op: () => Promise<boolean>): Promise<boolean> {
  const next = writes.then(op, op);
  writes = next;
  return next;
}

/** Run a write; true when it committed, false when storage refused or is unavailable. */
const attempt = <T>(run: (s: IDBObjectStore) => IDBRequest<T>): Promise<boolean> =>
  inOrder(async () => {
    try {
      await txn('readwrite', run);
      return true;
    } catch {
      return false;
    }
  });

/**
 * Store one table under its uid with its import date; re-storing the same uid replaces the old
 * copy. Resolves false when the write did not commit (storage blocked, full or unavailable).
 * The table must be a plain object: structured clone refuses a reactive proxy.
 */
export function putTable(uid: string, table: DeviceTable, importedAt?: number): Promise<boolean> {
  const record: StoredRecord =
    importedAt === undefined ? { v: 1, table } : { v: 1, table, importedAt };
  return attempt((s) => s.put(record, uid));
}

/** Delete one stored table; resolves false when the delete did not commit. */
export function deleteTable(uid: string): Promise<boolean> {
  return attempt((s) => s.delete(uid));
}

export function clearTables(): Promise<boolean> {
  return attempt((s) => s.clear());
}

/** A record as read back: the table (still unvalidated — see saneTable) and its import date
 *  when the record carries one. */
function unwrap(raw: unknown): { table: DeviceTable; importedAt?: number } {
  // A bare table has a grid; a record written with its date holds the table under `table`.
  if (raw && typeof raw === 'object' && 'table' in raw && !('grid' in raw)) {
    const { table, importedAt } = raw as Partial<StoredRecord>;
    return {
      table: table as DeviceTable,
      importedAt:
        typeof importedAt === 'number' && Number.isFinite(importedAt) ? importedAt : undefined,
    };
  }
  return { table: raw as DeviceTable };
}

/**
 * Every stored table WITH the key it is stored under; [] when storage is empty or
 * unavailable. The key matters: it is the uid of the algorithm that stored the
 * record, and deletion must target it — a uid recomputed by a newer algorithm can
 * differ, and deleting by the recomputed value would strand the record invisibly.
 */
export async function loadTables(): Promise<
  { key: string; table: DeviceTable; importedAt?: number }[]
> {
  try {
    const db = await open();
    try {
      const s = db.transaction(STORE, 'readonly').objectStore(STORE);
      // Same store, same transaction: both results are ordered by key, so the
      // arrays align index-for-index.
      const [keys, records] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return records.map((raw, i) => ({ key: String(keys[i]), ...unwrap(raw) }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Approximate size of a table's stored record in bytes: its axis vectors and quantity
 *  columns, which are all but a few hundred bytes of it. */
export function tableBytes(dt: DeviceTable): number {
  let n = 0;
  for (const a of dt.grid.axes) n += a.values.byteLength;
  for (const col of dt.grid.quantities.values()) n += col.byteLength;
  return n;
}

/**
 * A stored table restored with the one part of the importer's record of filled-in identity
 * (TableMeta.filled) that can be read back from a table stored before the record existed: the
 * importer sets `meta.temp` from a `# temp:` header and from nothing else, so a stored table
 * without one was read at the default temperature, which is said like any other default. Its
 * corner and device name cannot be told apart from declared ones and are left as stored. A
 * table that carries the record, or a temperature, is returned as it is.
 */
export function withRecordedFill(dt: DeviceTable): DeviceTable {
  if (dt.meta.filled !== undefined || dt.meta.temp !== undefined) return dt;
  // A stored identity at any temperature other than the default was declared: the default is
  // the only value the importer ever fills in.
  if (dt.id.temp !== DEFAULT_TEMP_C) return dt;
  return { ...dt, meta: { ...dt.meta, filled: ['temp'] } };
}

/**
 * Structural soundness of a restored record, checked before QA or lookup ever see
 * it: real, finite, strictly ascending axis vectors, a `shape` that agrees with
 * them, and every quantity column sized to the axis grid. IndexedDB contents are
 * still untrusted input — a corrupt or hand-edited record must be skipped, not
 * handed to interpolation.
 */
export function saneTable(dt: DeviceTable | undefined): dt is DeviceTable {
  if (!dt?.id?.device || !(dt.grid?.quantities instanceof Map)) return false;
  // The record of filled-in identity is read with `includes` everywhere a label or a nominal is
  // decided, so a stored one has to be the list the importer writes.
  const filled: unknown = dt.meta?.filled;
  if (
    filled !== undefined &&
    !(
      Array.isArray(filled) && filled.every((f) => f === 'device' || f === 'corner' || f === 'temp')
    )
  )
    return false;
  const { axes, shape } = dt.grid;
  if (!Array.isArray(axes) || axes.length === 0) return false;
  if (!Array.isArray(shape) || shape.length !== axes.length) return false;
  let n = 1;
  for (let i = 0; i < axes.length; i++) {
    const a = axes[i];
    if (typeof a?.name !== 'string' || !(a.values instanceof Float64Array)) return false;
    if (a.values.length === 0 || shape[i] !== a.values.length) return false;
    for (let j = 0; j < a.values.length; j++) {
      if (!Number.isFinite(a.values[j])) return false;
      if (j > 0 && a.values[j] <= a.values[j - 1]) return false;
    }
    n *= a.values.length;
  }
  if (dt.grid.quantities.size === 0) return false;
  for (const [k, col] of dt.grid.quantities)
    if (typeof k !== 'string' || !(col instanceof Float64Array) || col.length !== n) return false;
  return true;
}
