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

async function txn<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
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

/** Every stored table; [] when storage is empty or unavailable. */
export async function loadTables(): Promise<DeviceTable[]> {
  try {
    return await txn('readonly', (s) => s.getAll() as IDBRequest<DeviceTable[]>);
  } catch {
    return [];
  }
}
