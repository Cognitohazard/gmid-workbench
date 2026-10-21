// The sheet panel's evaluations, as data: what to run, and the one function that runs it. The
// worker (sheet.worker.ts) calls `runJob` off the page's thread; the evaluator falls back to
// calling it on the page when no worker can be started. Either way the numerics are the core's —
// this file only names which core call each job is, so the two paths cannot drift apart.
//
// No DOM and no Svelte: the worker bundle imports this file.

import {
  projectingResolver,
  runConditions,
  sheetSensitivities,
  sweepSheet,
  sweepSheet2,
  tableAt,
  type CharacterizedDevice,
  type ConditionKey,
  type ConditionRun,
  type DeviceLookup,
  type DeviceTable,
  type SheetDoc,
  type SheetRefHit,
  type SheetRefIndex,
  type SheetSensitivity,
  type SheetSweep,
  type SheetSweep2,
} from '@gmid/mostab-core';

/**
 * One evaluation the panel asks for. Each is exactly one core call:
 *  - `run`: the verdict — every asked condition, through `runConditions`;
 *  - `sweeps`: the 1-D margin chart, one sweep per condition asked (one, or the several of the
 *    multi-condition chart);
 *  - `sweep2`: the 2-D feasibility map at one condition;
 *  - `sens`: the sensitivity readout at one condition.
 * A condition is always read off the primary device, and every other binding is projected to it.
 */
export type SheetJob =
  | { kind: 'run'; doc: SheetDoc; keys: ConditionKey[]; base?: ConditionKey }
  | { kind: 'sweeps'; doc: SheetDoc; param: string; at: ConditionKey[]; points: number }
  | {
      kind: 'sweep2';
      doc: SheetDoc;
      param: string;
      param2: string;
      at: ConditionKey;
      points: number;
    }
  | { kind: 'sens'; doc: SheetDoc; at: ConditionKey; check?: string };

export type JobKind = SheetJob['kind'];

/** What each kind of job answers with. */
export interface JobResults {
  run: ConditionRun[];
  sweeps: { key: ConditionKey; sweep: SheetSweep }[];
  sweep2: SheetSweep2 | null;
  sens: SheetSensitivity[] | null;
}

/** Everything a job reads besides itself: the device the panel belongs to, how a sheet's device
 *  binding is matched to a device, and the sheet library references resolve against. */
export interface JobBench {
  primary: CharacterizedDevice;
  deviceOf: DeviceLookup;
  refs: SheetRefIndex;
}

/** Run one job. Never throws on a well-formed job: the core calls it makes do not. */
export function runJob(job: SheetJob, { primary, deviceOf, refs }: JobBench): JobResults[JobKind] {
  const at = (key: ConditionKey): DeviceTable | undefined => tableAt(primary, key);
  switch (job.kind) {
    case 'run':
      return runConditions(job.doc, primary, job.keys, deviceOf, refs, job.base);
    case 'sweeps': {
      const out: JobResults['sweeps'] = [];
      for (const key of job.at) {
        const t = at(key);
        if (!t) continue;
        out.push({
          key,
          sweep: sweepSheet(job.doc, job.param, t, job.points, projectingResolver(deviceOf, key)),
        });
      }
      return out;
    }
    case 'sweep2': {
      const t = at(job.at);
      return t
        ? sweepSheet2(
            job.doc,
            job.param,
            job.param2,
            t,
            job.points,
            projectingResolver(deviceOf, job.at),
          )
        : null;
    }
    case 'sens': {
      const t = at(job.at);
      return t
        ? sheetSensitivities(job.doc, t, projectingResolver(deviceOf, job.at), {
            refs,
            ...(job.check !== undefined ? { check: job.check } : {}),
          })
        : null;
    }
  }
}

// ── The wire format between the page and the worker ──────────────────────────────────────────

/** A device with its tables replaced by their ids: the worker holds the tables themselves, sent
 *  once each, so a request carries only this outline. */
export interface DeviceOutline extends Omit<CharacterizedDevice, 'conditions' | 'nominal'> {
  conditions: string[];
  nominal: string | undefined;
}

export interface JobRequest {
  id: number;
  job: SheetJob;
  /** Tables the worker does not hold yet, by id. */
  tables: [string, DeviceTable][];
  /** Every table id the request's devices hold: the worker drops any other it holds. */
  retain: string[];
  /** The sheet library, when it changed since the worker last received it. */
  refs?: [string, SheetRefHit][];
  /** The primary device and every device a binding in the sheet names. */
  devices: DeviceOutline[];
  primary: string;
  /** Each binding string the sheet uses → the device it names on the bench (absent: none). */
  bindings: [string, string][];
}

export type JobReply =
  { id: number; ok: true; result: JobResults[JobKind] } | { id: number; ok: false; error: string };

/** What the worker says once, as soon as it has loaded: from then on it can run jobs here. */
export interface WorkerReady {
  ready: true;
}
