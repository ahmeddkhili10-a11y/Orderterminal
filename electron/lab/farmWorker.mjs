// The edge finder's thread (see farmLoop.mjs): it runs for as long as the farm
// does, away from the desktop process's event loop and from the windows.
import { parentPort } from "node:worker_threads";
import { createFarmRunner } from "./farmLoop.mjs";

const runner = createFarmRunner((msg) => parentPort.postMessage(msg));
parentPort.on("message", (msg) => {
  runner
    .onMessage(msg)
    .catch((err) =>
      parentPort.postMessage({
        type: "error",
        error: String(err?.message ?? err),
      }),
    );
});
