// The sheet evaluation worker: runs the panel's jobs (sheetjobs.ts) off the page's thread, so a
// sheet that takes seconds to evaluate never freezes the page. It holds the device tables it has
// been sent, by id, so a request carries only the sheet and an outline of the bench. The page
// cancels a run that has been replaced by terminating this worker and starting a new one,
// because a run in progress cannot be interrupted from inside.

import type { CharacterizedDevice, DeviceTable, SheetRefIndex } from '@gmid/mostab-core';
import {
  runJob,
  type DeviceOutline,
  type JobReply,
  type JobRequest,
  type WorkerReady,
} from './sheetjobs';

const tables = new Map<string, DeviceTable>();
let refs: SheetRefIndex = new Map();

function hydrate(o: DeviceOutline): CharacterizedDevice {
  const table = (uid: string): DeviceTable => {
    const t = tables.get(uid);
    if (!t) throw new Error(`sheet worker: table ${uid} was never sent`);
    return t;
  };
  return {
    ...o,
    conditions: o.conditions.map(table),
    nominal: o.nominal === undefined ? undefined : table(o.nominal),
  };
}

self.onmessage = (e: MessageEvent<JobRequest>): void => {
  const m = e.data;
  let reply: JobReply;
  try {
    for (const [uid, t] of m.tables) tables.set(uid, t);
    const keep = new Set(m.retain);
    for (const uid of [...tables.keys()]) if (!keep.has(uid)) tables.delete(uid);
    if (m.refs) refs = new Map(m.refs);
    const devices = new Map(m.devices.map((o) => [o.deviceUid, hydrate(o)]));
    const primary = devices.get(m.primary);
    if (!primary) throw new Error('sheet worker: the primary device was not sent');
    const bound = new Map(m.bindings);
    const deviceOf = (binding: string): CharacterizedDevice | undefined => {
      const uid = bound.get(binding);
      return uid === undefined ? undefined : devices.get(uid);
    };
    reply = { id: m.id, ok: true, result: runJob(m.job, { primary, deviceOf, refs }) };
  } catch (err) {
    reply = { id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply);
};

self.postMessage({ ready: true } satisfies WorkerReady);
