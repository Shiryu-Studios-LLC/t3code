import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

export const swarmEnvironment = {
  launchAgent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:swarm:launch-agent",
    tag: WS_METHODS.providerSwarmLaunchAgent,
  }),
  messageAgent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:swarm:message-agent",
    tag: WS_METHODS.providerSwarmMessageAgent,
  }),
  stopAgent: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:swarm:stop-agent",
    tag: WS_METHODS.providerSwarmStopAgent,
  }),
};
