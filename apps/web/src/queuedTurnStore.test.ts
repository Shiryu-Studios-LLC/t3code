import { EnvironmentId, MessageId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { useQueuedTurnStore, type QueuedTurnSubmission } from "./queuedTurnStore";

function queuedTurn(id: string, text = id): QueuedTurnSubmission {
  return {
    id,
    environmentId: EnvironmentId.make("env-test"),
    threadId: ThreadId.make("thread-test"),
    messageId: MessageId.make(`message-${id}`),
    text,
    attachments: [],
    modelSelection: {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "opencode/nemotron-3-ultra-free",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-09-13T12:00:00.000Z",
    status: "queued",
    error: null,
  };
}

afterEach(() => {
  useQueuedTurnStore.setState({ byThreadKey: {} });
});

describe("queuedTurnStore", () => {
  it("keeps queued turns in FIFO order", () => {
    const store = useQueuedTurnStore.getState();
    store.enqueue("env:thread", queuedTurn("first"));
    store.enqueue("env:thread", queuedTurn("second"));

    expect(useQueuedTurnStore.getState().byThreadKey["env:thread"]?.map((turn) => turn.id)).toEqual(
      ["first", "second"],
    );
  });

  it("tracks sending, failed, retry, and removal without reordering", () => {
    const store = useQueuedTurnStore.getState();
    store.enqueue("env:thread", queuedTurn("first"));
    store.enqueue("env:thread", queuedTurn("second"));

    store.markSending("env:thread", "first");
    expect(useQueuedTurnStore.getState().byThreadKey["env:thread"]?.[0]?.status).toBe("sending");

    store.markFailed("env:thread", "first", "network failed");
    expect(useQueuedTurnStore.getState().byThreadKey["env:thread"]?.[0]).toMatchObject({
      id: "first",
      status: "failed",
      error: "network failed",
    });

    store.markQueued("env:thread", "first");
    expect(useQueuedTurnStore.getState().byThreadKey["env:thread"]?.[0]).toMatchObject({
      id: "first",
      status: "queued",
      error: null,
    });

    store.remove("env:thread", "first");
    expect(useQueuedTurnStore.getState().byThreadKey["env:thread"]?.map((turn) => turn.id)).toEqual(
      ["second"],
    );

    store.remove("env:thread", "second");
    expect(useQueuedTurnStore.getState().byThreadKey["env:thread"]).toBeUndefined();
  });
});
