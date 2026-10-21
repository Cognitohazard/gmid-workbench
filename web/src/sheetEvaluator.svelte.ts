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
// When no worker can be started at all, the same jobs run on the page instead. The page is less
// responsive then, but the answers are the same.

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
  jobReply,
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
const PRIORITY: readonly JobKind[] = ['run', 'sens', 'sweeps', 'sweep2'];

/** How long a superseded job may keep running before it is cancelled, in ms, counted from when
 *  its worker had loaded. About what an ordinary sheet takes, and well under the seconds a large
 *  one does. */
const GRACE_MS = 150;

export type JobOf<K extends JobKind> = Extract<SheetJob, { kind: K }>;

/** The request an answer belongs to, delivered with it: the job as it was asked for, and what the
 *  caller said the request is about (`about`, see SheetEvaluator.request). A caller reads whether
 *  an answer still belongs on screen from this, and from nothing it remembered on the side. */
export interface Answered<K extends JobKind, A = unknown> {
  job: JobOf<K>;
  about: A;
}

interface Pending {
  kind: JobKind;
  job: SheetJob;
  /** Identity of the request — job plus everything it reads — so asking again for exactly the
   *  same thing neither re-runs nor cancels it. */
  key: string;
  /** What the caller says the request is about; delivered back, never read here. */
  about: unknown;
  bench: Bench;
  primary: CharacterizedDevice;
  refs: SheetRefIndex;
  deliver: (result: unknown, answered: Answered<JobKind>) => void;
  fail: (error: string) => void;
}

interface Running extends Pending {
  id: number;
  /** When its grace period began: when it was sent, or when the worker loaded if that was later. */
  started: number;
  /** A newer request of the same kind is queued behind it. */
  superseded: boolean;
}

/** A table as the worker can receive it. The bench keeps its tables in Svelte state, whose
 *  proxies cannot cross to a worker; the bulk columns inside are never proxied, so this copies
 *  only the small parts and hands the typed arrays over as they are. Every field but the grid is
 *  copied as it is, so a field a table gains reaches the worker as it reaches the page. */
function plainTable(t: DeviceTable): DeviceTable {
  const { grid, ...rest } = t;
  return {
    ...($state.snapshot(rest) as Omit<DeviceTable, 'grid'>),
    grid: {
      axes: grid.axes.map((a) => ({ name: a.name, values: a.values })),
      shape: [...grid.shape],
      quantities: new Map(grid.quantities),
    },
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
  /** Which kinds of job are waiting or running, in PRIORITY order — the panel's busy indicator.
   *  Reassigned only when the set changes, so a request that changes nothing does not make the
   *  panel update. */
  #busy = $state.raw<readonly JobKind[]>([]);

  /** Whether a job of `kind` (or, with no kind, any job) is waiting or running. */
  busy(kind?: JobKind): boolean {
    return kind === undefined ? this.#busy.length > 0 : this.#busy.includes(kind);
  }

  /**
   * Ask for `job`, replacing any earlier request of its kind that has not started. `deliver`
   * receives the answer with the request it answers (Answered): the job, and `ctx.about` — what
   * the caller says this request is about, which it compares with what it shows now. Answers of
   * one kind arrive in the order they were asked for, so the last one delivered is always the
   * latest that finished; a job that was cancelled (superseded past its grace, or withdrawn) is
   * never delivered. A request whose answer was the last one delivered is answered again at once
   * from that answer, so asking for the same thing again (after an unrelated change, or after
   * going back to an earlier value) does not run it twice. An answer that serves a later request
   * with the same key is delivered as that request's. `fail` is called for a job that could not
   * run at all (the core itself never throws).
   */
  request<K extends JobKind, A = undefined>(
    job: JobOf<K>,
    ctx: { bench: Bench; primary: CharacterizedDevice; refs: SheetRefIndex; about?: A },
    deliver: (result: JobResults[K], answered: Answered<K, A>) => void,
    fail: (error: string) => void = () => {},
  ): void {
    if (this.#disposed) return;
    const snap = $state.snapshot(job) as SheetJob;
    const key = `${JSON.stringify(snap)}|${ctx.bench.revision}|${refsId(ctx.refs)}`;
    const { about, ...bench } = ctx;
    const done = this.#done.get(job.kind);
    if (done?.key === key) {
      // This request was already answered. Withdraw any newer request of this kind, so that its
      // answer cannot arrive after this one.
      this.cancel(job.kind);
      deliver(done.result as JobResults[K], { job: snap as JobOf<K>, about: about as A });
      return;
    }
    const p: Pending = {
      kind: job.kind,
      job: snap,
      key,
      about,
      ...bench,
      deliver: deliver as unknown as Pending['deliver'],
      fail,
    };
    const running = this.#running;
    if (running?.kind === job.kind && running.key === key) {
      // The running job already answers this request. Send its answer to this caller, as this
      // request's, and drop any request of this kind queued since, because this one replaces it.
      running.deliver = p.deliver;
      running.fail = p.fail;
      running.about = p.about;
      running.superseded = false;
      this.#queue.delete(job.kind);
      this.#mark();
      return;
    }
    if (this.#queue.get(job.kind)?.key === key) return;
    this.#queue.set(job.kind, p);
    if (running?.kind === job.kind) this.#supersede(running);
    this.#settle();
  }

  /** Withdraw the request of `kind`, because its answer is no longer needed. If that job is
   *  running, its worker is stopped. On the page a job cannot be running when this is called, so
   *  it simply never starts. */
  cancel(kind: JobKind): void {
    this.#queue.delete(kind);
    if (this.#running?.kind === kind) this.#restart();
    this.#settle();
  }

  /** A newer request of the running job's kind is queued. Cancel the running job when its grace
   *  period ends, unless it has finished, or been requested again, by then. */
  #supersede(job: Running): void {
    if (job.superseded) return; // its cancellation is already timed
    job.superseded = true;
    if (!this.#worker) return; // on the page it cannot be stopped; #runInline skips it if unstarted
    const kill = (): void => {
      if (this.#running !== job || !job.superseded) return;
      // The grace period restarts when a new worker finishes loading, so check it again.
      const left = GRACE_MS - (performance.now() - job.started);
      if (left > 0) {
        setTimeout(kill, left);
        return;
      }
      this.#restart();
      this.#settle();
    };
    kill();
  }

  /** Stop all work, because the panel has been closed. */
  dispose(): void {
    this.#disposed = true;
    this.#queue.clear();
    this.#restart();
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

  /** Start the next job if nothing is running, then bring the busy indicator up to date. */
  #settle(): void {
    this.#pump();
    this.#mark();
  }

  #mark(): void {
    const busy = PRIORITY.filter((k) => this.#queue.has(k) || this.#running?.kind === k);
    if (busy.join() !== this.#busy.join()) this.#busy = busy;
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
    // If the worker stops with an error, its job is lost. If it stopped before it finished
    // loading, this browser cannot run the worker, so every later job runs on the page. If it
    // stopped later (for example, out of memory), the job is reported as failed and the other
    // jobs continue.
    let loaded = false;
    w.onmessage = (e: MessageEvent<JobReply | WorkerReady>) => {
      if (!('ready' in e.data)) return this.#reply(w, e.data);
      loaded = true;
      // Start the job's grace period now, so the time spent loading the worker is not counted.
      if (w === this.#worker && this.#running) this.#running.started = performance.now();
    };
    w.onerror = (e) => {
      e.preventDefault();
      if (w !== this.#worker) return;
      const job = this.#running;
      this.#restart();
      if (!loaded) this.#inline = true;
      if (job) {
        // Run the job on the page instead, unless a newer request of its kind replaced it.
        if (this.#inline) {
          if (!this.#queue.has(job.kind)) this.#queue.set(job.kind, job);
        } else job.fail(e.message || 'the evaluation worker stopped');
      }
      this.#settle();
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
    if (r.ok) {
      this.#done.set(job.kind, { key: job.key, result: r.result });
      job.deliver(r.result, { job: job.job as JobOf<JobKind>, about: job.about });
    } else job.fail(r.error);
    this.#settle();
  }

  #pump(): void {
    if (this.#running || this.#disposed) return;
    const kind = PRIORITY.find((k) => this.#queue.has(k));
    if (kind === undefined) return;
    const p = this.#queue.get(kind) as Pending;
    this.#queue.delete(kind);
    const id = ++this.#seq;
    this.#running = { ...p, id, started: performance.now(), superseded: false };
    const w = this.#spawn();
    if (!w) {
      // On the page, run one job per task, so the panel can redraw between jobs.
      setTimeout(() => this.#runInline(id), 0);
      return;
    }
    w.postMessage(this.#message(id, p));
  }

  #runInline(id: number): void {
    const job = this.#running;
    if (!job || job.id !== id) return; // cancelled before it started
    if (job.superseded) {
      // This job never started and a newer request of its kind is queued, so skip it.
      this.#running = null;
      this.#settle();
      return;
    }
    const bench = { primary: job.primary, deviceOf: job.bench.deviceOf, refs: job.refs };
    this.#finish(
      job,
      jobReply(id, () => runJob(job.job, bench)),
    );
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
    // The worker keeps only the tables of the devices this sheet reads, so a panel holds a copy
    // of what it evaluates rather than of the whole bench.
    const outlines = [...devices.values()].map((d): DeviceOutline => ({
      ...$state.snapshot({ ...d, conditions: [], nominal: undefined }),
      conditions: d.conditions.map(tableUid),
      nominal: d.nominal === undefined ? undefined : tableUid(d.nominal),
    }));
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- scratch for one message
    const kept = new Set(outlines.flatMap((o) => o.conditions));
    for (const uid of [...this.#sent]) if (!kept.has(uid)) this.#sent.delete(uid);
    const tables: [string, DeviceTable][] = [];
    for (const d of devices.values())
      for (const t of d.conditions) {
        const uid = tableUid(t);
        if (this.#sent.has(uid)) continue;
        tables.push([uid, plainTable(t)]);
        this.#sent.add(uid);
      }
    const req: JobRequest = {
      id,
      job: p.job,
      tables,
      devices: outlines,
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
