// The thread the heavy panel maths runs on (see heavy.ts): asked a task by name, it answers
// with the result, so the page stays free for the mouse and the live data meanwhile.
import { TASKS, type TaskName } from './heavy';

self.onmessage = (e: MessageEvent<{ id: number; task: TaskName; args: never }>) => {
  const { id, task, args } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, value: TASKS[task](args) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String((err as Error)?.message ?? err) });
  }
};
