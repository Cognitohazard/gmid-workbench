// The sheet panel's evaluations, as data: what to run, and the one function that runs it. The
// worker (sheet.worker.ts) calls `runJob` off the page's thread; the evaluator falls back to
// calling it on the page when no worker can be started. Either way the calculations are the
// core's; this file only maps each job to one core call, so the two paths give the same results.
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

/** The conditions a job evaluates at: every condition it asks about, and the one a run sizes its
 *  design at. A table at any other condition is never evaluated by it. */
export function jobConditions(job: SheetJob): ConditionKey[] {
  switch (job.kind) {
    case 'run':
      return job.base ? [...job.keys, job.base] : [...job.keys];
    case 'sweeps':
      return [...job.at];
    case 'sweep2':
    case 'sens':
      return [job.at];
  }
}

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
  /** Tables the job evaluates (jobConditions) that the worker does not hold yet, by id. The worker
   *  keeps only the tables the request's devices hold, and drops any other. */
  tables: [string, DeviceTable][];
  /** Every other table of the request's devices that the worker does not hold, as an outline: its
   *  identity and axes, with no columns. Projection reads that much of every condition of a
   *  device (`tableAt` matches identities, `canProjectAt` compares axes); the job evaluates only
   *  conditions whose tables it was sent in full, so nothing is ever evaluated on an outline. */
  outlines: [string, DeviceTable][];
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

/** The reply to job `id`: what `run` answers, or the error it threw. The one shape the worker and
 *  the page reply in, so the two paths cannot report a failure differently. */
export function jobReply(id: number, run: () => JobResults[JobKind]): JobReply {
  try {
    return { id, ok: true, result: run() };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** What the worker says once, as soon as it has loaded: from then on it can run jobs here. */
export interface WorkerReady {
  ready: true;
}
