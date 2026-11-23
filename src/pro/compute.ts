// Heavy panel maths off the page's thread. `useCompute` hands a task (heavy.ts) to one shared
// worker and gives the panel the answer when it comes; until then the panel keeps showing what
// it had (when it is still about the same thing), so nothing flickers on a refresh. Where a
// worker cannot be had (tests, an old browser) the task runs on the page after the frame is drawn.
import { useEffect, useRef, useState } from 'react';
import { TASKS, type TaskArgs, type TaskName, type TaskResult } from './heavy';

type Waiter = { task: TaskName; args: unknown; done: (v: unknown) => void; fail: (e: Error) => void };
let worker: Worker | null | undefined;
let starting: Promise<Worker | null> | null = null;
const waiting = new Map<number, Waiter>();
let seq = 0;

const onPage = (task: TaskName, args: unknown) =>
  new Promise((done, fail) =>
    setTimeout(() => {
      try {
        done(TASKS[task](args as never));
      } catch (e) {
        fail(e as Error);
      }
    }, 0),
  );

function getWorker(): Promise<Worker | null> {
  if (worker !== undefined) return Promise.resolve(worker);
  if (typeof Worker === 'undefined') return Promise.resolve((worker = null));
  starting ??= import('./compute.worker?worker&inline')
    .then((m) => {
      const w: Worker = new m.default();
      w.onmessage = (e: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
        const job = waiting.get(e.data.id);
        if (!job) return;
        waiting.delete(e.data.id);
        if (e.data.error != null) job.fail(new Error(e.data.error));
        else job.done(e.data.value);
      };
      // the thread could not start or died: what it was doing is done on the page instead, and so is everything after
      w.onerror = () => {
        worker = null;
        w.terminate();
        const jobs = [...waiting.values()];
        waiting.clear();
        for (const j of jobs) onPage(j.task, j.args).then(j.done, j.fail);
      };
      return (worker = w);
    })
    .catch(() => (worker = null));
  return starting;
}

/** one task, on the worker when there is one */
export async function runTask<K extends TaskName>(task: K, args: TaskArgs<K>): Promise<TaskResult<K>> {
  const w = await getWorker();
  if (!w) return onPage(task, args) as Promise<TaskResult<K>>;
  const id = ++seq;
  return new Promise((done, fail) => {
    waiting.set(id, { task, args, done: done as (v: unknown) => void, fail });
    w.postMessage({ id, task, args });
  });
}

/**
 * The result of `task` on `args`, worked out off the page's thread. `key` says when the inputs
 * changed (a new candle, another setting); `about` says what the result is about (the coins, the
 * coin): while a new result is worked out the old one stays on show if `about` is unchanged, and
 * is dropped if it changed (it would be about something else). `args` null: nothing to work out.
 */
export function useCompute<K extends TaskName>(task: K, args: TaskArgs<K> | null, key: string, about: string): { value: TaskResult<K> | undefined; busy: boolean } {
  const [st, setSt] = useState<{ value: TaskResult<K> | undefined; about: string; key: string }>({ value: undefined, about, key: '' });
  const [busy, setBusy] = useState(false);
  const argsRef = useRef(args);
  argsRef.current = args;
  useEffect(() => {
    const a = argsRef.current;
    if (a == null) {
      setSt({ value: undefined, about, key });
      setBusy(false);
      return;
    }
    let alive = true;
    setBusy(true);
    runTask(task, a)
      .then((value) => alive && setSt({ value, about, key }))
      .catch(() => alive && setSt({ value: undefined, about, key }))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, key, args == null]);
  return { value: st.about === about ? st.value : undefined, busy };
}
