// Local persistence for loaded device tables — IndexedDB, because a characterization
// grid (megabytes of Float64Array) is far past localStorage budgets and structured
// clone stores Maps and typed arrays natively. Client-only like everything else: the
// data never leaves the machine. Every stored table has a visible chip in the devices
// strip with a remove control, and clear-all wipes the store — so what is retained is
// always inspectable and deletable. All operations are best-effort: blocked or
// unavailable storage (private mode, some file:// contexts) degrades to the previous
// in-memory-only behavior, never to an error the user must handle.

import type { DeviceTable } from '@gmid/mostab-core';

const DB = 'gmid';
const STORE = 'tables';

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

async function txn<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await req(run(db.transaction(STORE, mode).objectStore(STORE)));
  } finally {
    db.close();
  }
}

/** Store one table under its uid; re-storing the same uid replaces the old copy. */
export async function putTable(uid: string, table: DeviceTable): Promise<void> {
  try {
    await txn('readwrite', (s) => s.put(table, uid));
  } catch {
    // best-effort
  }
}

export async function deleteTable(uid: string): Promise<void> {
  try {
    await txn('readwrite', (s) => s.delete(uid));
  } catch {
    // best-effort
  }
}

export async function clearTables(): Promise<void> {
  try {
    await txn('readwrite', (s) => s.clear());
  } catch {
    // best-effort
  }
}

/**
 * Every stored table WITH the key it is stored under; [] when storage is empty or
 * unavailable. The key matters: it is the uid of the algorithm that stored the
 * record, and deletion must target it — a uid recomputed by a newer algorithm can
 * differ, and deleting by the recomputed value would strand the record invisibly.
 */
export async function loadTables(): Promise<{ key: string; table: DeviceTable }[]> {
  try {
    const db = await open();
    try {
      const s = db.transaction(STORE, 'readonly').objectStore(STORE);
      // Same store, same transaction: both results are ordered by key, so the
      // arrays align index-for-index.
      const [keys, tables] = await Promise.all([
        req(s.getAllKeys()),
        req(s.getAll() as IDBRequest<DeviceTable[]>),
      ]);
      return tables.map((table, i) => ({ key: String(keys[i]), table }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
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
