import { afterEach, describe, expect, test } from "bun:test";
import { INBOX_NAME, openSinkRoot } from "../src/worker/sinkRoot.js";

// Regression for "could not be cloned" on Safari/Firefox receivers: the OPFS
// inbox must be opened inside the worker from a *name*, never passed as a handle.

const g = globalThis as unknown as { navigator?: unknown };
const realNavigator = g.navigator;
function fakeStorage(): { opened: string[] } {
  const opened: string[] = [];
  const dir = (name: string) => ({
    kind: "directory",
    name,
    getDirectoryHandle: async (n: string, o?: { create?: boolean }) => {
      opened.push(`${n}:${o?.create ? "create" : "open"}`);
      return dir(n);
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => dir("") } },
  });
  return { opened };
}
afterEach(() => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: realNavigator });
});

describe("openSinkRoot", () => {
  test("opens a named inbox from the worker's own storage", async () => {
    const { opened } = fakeStorage();
    const root = (await openSinkRoot({ kind: "fsaccess", inbox: "dropbeam-inbox" })) as { name: string };
    expect(root.name).toBe("dropbeam-inbox");
    expect(opened).toEqual(["dropbeam-inbox:create"]);
  });

  test("inbox wins over a directory and needs no handle", async () => {
    fakeStorage();
    const root = (await openSinkRoot({ kind: "fsaccess", inbox: "x", directory: { name: "ignored" } })) as { name: string };
    expect(root.name).toBe("x");
  });

  test("a chosen folder handle is used as-is", async () => {
    const handle = { name: "Downloads" };
    expect(await openSinkRoot({ kind: "fsaccess", directory: handle })).toBe(handle as never);
  });

  test("proxy sinks need no root", async () => {
    expect(await openSinkRoot({ kind: "proxy" })).toBeNull();
  });

  test("rejects unsafe inbox names", async () => {
    fakeStorage();
    for (const bad of ["", ".", "..", "a/b", "a\\b", "x".repeat(65)]) {
      expect(INBOX_NAME.test(bad)).toBe(false);
      await expect(openSinkRoot({ kind: "fsaccess", inbox: bad })).rejects.toThrow("invalid inbox name");
    }
  });

  test("clear error when the browser has no private storage", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await expect(openSinkRoot({ kind: "fsaccess", inbox: "dropbeam-inbox" })).rejects.toThrow("no private file storage");
  });

  test("fsaccess with neither inbox nor folder is refused", async () => {
    await expect(openSinkRoot({ kind: "fsaccess" })).rejects.toThrow("no folder");
  });
});

describe("WorkerTransferHost hand-off", () => {
  test("a DataCloneError rejects the session instead of hanging", async () => {
    const { WorkerTransferHost } = await import("../src/worker/workerClient.js");
    const listeners: Array<(ev: { data: unknown }) => void> = [];
    const worker = {
      addEventListener: (_t: string, l: (ev: { data: unknown }) => void) => listeners.push(l),
      removeEventListener: () => {},
      terminate: () => {},
      postMessage: (msg: { type: string }) => {
        if (msg.type === "receive") {
          const e = new Error("Failed to execute 'postMessage' on 'Worker': FileSystemDirectoryHandle object could not be cloned.");
          e.name = "DataCloneError";
          throw e;
        }
      },
    };
    const pc = { addEventListener: () => {}, removeEventListener: () => {} };
    const host = new WorkerTransferHost({ worker: worker as never, peerConnection: pc as never });
    for (const l of listeners) l({ data: { type: "ready" } });
    await expect(
      host.receive({ sink: { kind: "fsaccess", directory: { name: "d" } as never } }),
    ).rejects.toThrow(/worker-handoff-failed: DataCloneError/);
  });
});
