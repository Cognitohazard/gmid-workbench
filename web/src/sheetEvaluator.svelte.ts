// Runs a sheet panel's evaluations off the page's thread. A composed sheet with an operating
// range takes seconds per run, a sweep is dozens of runs and a design-plane map hundreds; on the
// page's thread each one froze the whole app on open and after every edit.
//
// One evaluator per panel, one worker per evaluator. The panel asks for the latest version of
// each kind of job (sheetjobs.ts); a newer request of a kind replaces a queued older one. The
// worker runs one job at a time, verdict first, so the answers of one kind arrive in the order
// they were asked for. A request that supersedes the job the worker is RUNNING cancels it: a run
// in progress cannot be interrupted from inside, so the worker is terminated and a fresh one
// picks up what is still wanted, its table cache re-sent as the next jobs need it. Cancelling
// costs a restart, so a job gets a short grace first: one that finishes within it is delivered
// (it is still newer than what the panel shows, which keeps a slider drag live), and only one
// still running after it is cancelled.
//
// When no worker can be started at all, the same jobs run on the page instead — slower to feel,
// never a different answer.

import {
  namedBindings,
  type CharacterizedDevice,
  type DeviceTable,
  type SheetRefHit,
  type SheetRefIndex,
} from '@gmid/mostab-core';
import SheetWorker from './sheet.worker.ts?worker&inline';
import { tableUid } from './dashboard';
import type { Bench } from './families';
import {
  runJob,
  type DeviceOutline,
  type JobKind,
  type JobReply,
  type JobRequest,
  type JobResults,
  type SheetJob,
  type WorkerReady,
} from './sheetjobs';

/** The order queued jobs run in: the verdict first, because everything on the panel reads it. */
const PRIORITY: readonly JobKind[] = ['run', 'sens', 'sweep', 'sweeps', 'sweep2'];

/** How long a superseded job may keep running before it is cancelled, in ms. About what an
 *  ordinary sheet takes, and well under the seconds a large one does. */
const GRACE_MS = 150;

type JobOf<K extends JobKind> = Extract<SheetJob, { kind: K }>;

interface Pending {
  kind: JobKind;
  job: SheetJob;
  /** Identity of the request — job plus everything it reads — so asking again for exactly the
   *  same thing neither re-runs nor cancels it. */
  key: string;
  bench: Bench;
  primary: CharacterizedDevice;
  refs: SheetRefIndex;
  deliver: (result: unknown) => void;
  fail: (error: string) => void;
}

interface Running extends Pending {
  id: number;
  started: number;
  /** A newer request of the same kind is queued behind it. */
  superseded: boolean;
  /** Its answer is no longer wanted at all. */
  cancelled: boolean;
}

/** A table as the worker can receive it. The bench keeps its tables in Svelte state, whose
 *  proxies cannot cross to a worker; the bulk columns inside are never proxied, so this copies
 *  only the small parts and hands the typed arrays over as they are. */
function plainTable(t: DeviceTable): DeviceTable {
  return {
    id: $state.snapshot(t.id),
    meta: $state.snapshot(t.meta),
    grid: {
      axes: t.grid.axes.map((a) => ({ name: a.name, values: a.values })),
      shape: [...t.grid.shape],
      quantities: new Map(t.grid.quantities),
    },
    ...(t.passthrough ? { passthrough: new Set(t.passthrough) } : {}),
  };
}

function plainRefs(refs: SheetRefIndex): [string, SheetRefHit][] {
  return [...refs].map(([k, hit]) => [
    k,
    'doc' in hit ? { doc: $state.snapshot(hit.doc) } : { ambiguous: [...hit.ambiguous] },
  ]);
}

/** A number per sheet library the page has built, so a request can name the one it means
 *  without serializing it. */
const refsIds = new WeakMap<SheetRefIndex, number>();
let nextRefsId = 0;
const refsId = (refs: SheetRefIndex): number => {
  let id = refsIds.get(refs);
  if (id === undefined) refsIds.set(refs, (id = ++nextRefsId));
  return id;
};

export class SheetEvaluator {
  #worker: Worker | null = null;
  /** No worker could be started here, so jobs run on the page. */
  #inline = false;
  /** Table ids the current worker holds. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
  #sent = new Set<string>();
  /** The sheet library the current worker holds. */
  #refsSent: SheetRefIndex | null = null;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping; #busy is what renders
  #queue = new Map<JobKind, Pending>();
  #running: Running | null = null;
  /** The last answer delivered of each kind, with the request it answers. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
  #done = new Map<JobKind, { key: string; result: unknown }>();
  #seq = 0;
  #disposed = false;
  /** Which kinds of job are waiting or running — the panel's busy indicator. */
  #busy = $state<Partial<Record<JobKind, true>>>({});

  /** Whether a job of `kind` (or, with no kind, any job) is waiting or running. */
  busy(kind?: JobKind): boolean {
    return kind === undefined ? Object.keys(this.#busy).length > 0 : this.#busy[kind] === true;
  }

  /**
   * Ask for `job`, replacing any earlier request of its kind that has not started. `deliver`
   * receives the answer. Answers of one kind arrive in the order they were asked for, so the last
   * one delivered is always the latest that finished; a job that was cancelled (superseded past
   * its grace, or withdrawn) is never delivered. A request whose answer was the last one
   * delivered is answered again at once, from that answer: asking a question again — because
   * something it does not depend on changed, or because the user went back to it — never pays
   * for a second run. `fail` hears of a job that could not run at all (the core itself never
   * throws).
   */
  request<K extends JobKind>(
    job: JobOf<K>,
    ctx: { bench: Bench; primary: CharacterizedDevice; refs: SheetRefIndex },
    deliver: (result: JobResults[K]) => void,
    fail: (error: string) => void = () => {},
  ): void {
    if (this.#disposed) return;
    const snap = $state.snapshot(job) as SheetJob;
    const key = `${JSON.stringify(snap)}|${ctx.bench.revision}|${refsId(ctx.refs)}`;
    const p: Pending = {
      kind: job.kind,
      job: snap,
      key,
      ...ctx,
      deliver: deliver as (r: unknown) => void,
      fail,
    };
    const running = this.#running;
    const done = this.#done.get(job.kind);
    if (done?.key === key) {
      // Already answered. Whatever was asked for since is no longer the question, and must not
      // land after this answer: it is withdrawn, and a running one is never delivered.
      this.#queue.delete(job.kind);
      if (running?.kind === job.kind) {
        running.cancelled = true;
        if (this.#worker) this.#restart();
      }
      this.#mark();
      this.#pump();
      deliver(done.result as JobResults[K]);
      return;
    }
    if (running?.kind === job.kind && running.key === key) {
      // The same question is already being answered: answer this caller instead, and drop
      // anything queued since — asking again means the question went back to this one.
      running.deliver = p.deliver;
      running.fail = p.fail;
      running.superseded = false;
      this.#queue.delete(job.kind);
      this.#mark();
      return;
    }
    if (this.#queue.get(job.kind)?.key === key) return;
    this.#queue.set(job.kind, p);
    if (running?.kind === job.kind) this.#supersede(running);
    this.#mark();
    this.#pump();
  }

  /** Withdraw the request of `kind`: its answer is no longer wanted. */
  cancel(kind: JobKind): void {
    this.#queue.delete(kind);
    const running = this.#running;
    if (running?.kind === kind) {
      running.cancelled = true;
      if (this.#worker) {
        this.#restart();
        this.#pump();
      }
    }
    this.#mark();
  }

  /** A newer request of the running job's kind is queued: cancel the running one once its grace
   *  is spent, unless it has finished (or been asked for again) by then. */
  #supersede(job: Running): void {
    job.superseded = true;
    if (!this.#worker) return; // on the page it cannot be stopped; #runInline skips it if unstarted
    const kill = (): void => {
      if (this.#running !== job || !job.superseded) return;
      this.#restart();
      this.#pump();
    };
    const left = GRACE_MS - (performance.now() - job.started);
    if (left <= 0) kill();
    else setTimeout(kill, left);
  }

  /** Stop everything: the panel is gone. */
  dispose(): void {
    this.#disposed = true;
    this.#queue.clear();
    this.#running = null;
    this.#worker?.terminate();
    this.#worker = null;
    this.#mark();
  }

  /** Abandon the running job by terminating the worker it runs in; the next pump starts another. */
  #restart(): void {
    this.#running = null;
    this.#worker?.terminate();
    this.#worker = null;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- bookkeeping, never rendered
    this.#sent = new Set();
    this.#refsSent = null;
  }

  #mark(): void {
    const busy: Partial<Record<JobKind, true>> = {};
    for (const k of this.#queue.keys()) busy[k] = true;
    if (this.#running) busy[this.#running.kind] = true;
    this.#busy = busy;
  }

  #spawn(): Worker | null {
    if (this.#inline) return null;
    if (this.#worker) return this.#worker;
    let w: Worker;
    try {
      w = new SheetWorker();
    } catch {
      this.#inline = true;
      return null;
    }
    // A worker that dies takes its job with it. One that died before it had even loaded cannot
    // run here at all (a browser that refuses workers from this page), so the page evaluates
    // from then on; one that died later (out of memory, say) fails its job and the rest go on.
    let loaded = false;
    w.onmessage = (e: MessageEvent<JobReply | WorkerReady>) => {
      if ('ready' in e.data) loaded = true;
      else this.#reply(w, e.data);
    };
    w.onerror = (e) => {
      e.preventDefault();
      if (w !== this.#worker) return;
      const job = this.#running;
      this.#restart();
      if (!loaded) this.#inline = true;
      if (job && !job.cancelled) {
        // Unable to run here: ask the page instead, unless a newer request already replaced it.
        if (this.#inline) {
          if (!this.#queue.has(job.kind)) this.#queue.set(job.kind, job);
        } else job.fail(e.message || 'the evaluation worker stopped');
      }
      this.#mark();
      this.#pump();
    };
    this.#worker = w;
    return w;
  }

  #reply(w: Worker, r: JobReply): void {
    const job = this.#running;
    if (w !== this.#worker || !job || r.id !== job.id) return; // a job since abandoned
    this.#finish(job, r);
  }

  #finish(job: Running, r: JobReply): void {
    this.#running = null;
    if (!job.cancelled) {
      if (r.ok) {
        this.#done.set(job.kind, { key: job.key, result: r.result });
        job.deliver(r.result);
      } else job.fail(r.error);
    }
    this.#mark();
    this.#pump();
  }

  #pump(): void {
    if (this.#running || this.#disposed) return;
    const kind = PRIORITY.find((k) => this.#queue.has(k));
    if (kind === undefined) return;
    const p = this.#queue.get(kind) as Pending;
    this.#queue.delete(kind);
    const id = ++this.#seq;
    this.#running = { ...p, id, started: performance.now(), superseded: false, cancelled: false };
    const w = this.#spawn();
    if (!w) {
      // On the page, one job per task, so the panel paints between jobs.
      setTimeout(() => this.#runInline(id), 0);
      return;
    }
    w.postMessage(this.#message(id, p));
  }

  #runInline(id: number): void {
    const job = this.#running;
    if (!job || job.id !== id) return;
    if (job.superseded || job.cancelled) {
      // Not started, and no longer the question: the newer request queued behind it runs instead.
      this.#running = null;
      this.#mark();
      this.#pump();
      return;
    }
    let reply: JobReply;
    try {
      const bench = { primary: job.primary, deviceOf: job.bench.deviceOf, refs: job.refs };
      reply = { id, ok: true, result: runJob(job.job, bench) };
    } catch (err) {
      reply = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.#finish(job, reply);
  }

  /** The request for `p`: its job, an outline of the devices it reads, and whatever the worker
   *  does not hold yet. */
  #message(id: number, p: Pending): JobRequest {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- scratch for one message
    const devices = new Map<string, CharacterizedDevice>([[p.primary.deviceUid, p.primary]]);
    const bindings: [string, string][] = [];
    for (const { binding } of namedBindings(p.job.doc, p.refs).bindings) {
      const d = p.bench.deviceOf(binding);
      if (!d) continue;
      bindings.push([binding, d.deviceUid]);
      devices.set(d.deviceUid, d);
    }
    const tables: [string, DeviceTable][] = [];
    const outline = (d: CharacterizedDevice): DeviceOutline => {
      const conditions = d.conditions.map((t) => {
        const uid = tableUid(t);
        if (!this.#sent.has(uid)) {
          tables.push([uid, plainTable(t)]);
          this.#sent.add(uid);
        }
        return uid;
      });
      return {
        ...$state.snapshot({ ...d, conditions: [], nominal: undefined }),
        conditions,
        nominal: d.nominal === undefined ? undefined : tableUid(d.nominal),
      };
    };
    const retain = p.bench.devices.flatMap((d) => d.conditions.map(tableUid));
    // The worker drops every table not retained, so it no longer holds those.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- scratch for one message
    const kept = new Set(retain);
    for (const uid of [...this.#sent]) if (!kept.has(uid)) this.#sent.delete(uid);
    const req: JobRequest = {
      id,
      job: p.job,
      tables,
      retain,
      devices: [...devices.values()].map(outline),
      primary: p.primary.deviceUid,
      bindings,
    };
    if (this.#refsSent !== p.refs) {
      req.refs = plainRefs(p.refs);
      this.#refsSent = p.refs;
    }
    return req;
  }
}
