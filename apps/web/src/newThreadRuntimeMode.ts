import { DEFAULT_RUNTIME_MODE, type RuntimeMode } from "@t3tools/contracts";

/**
 * Permission mode for a newly-created conversation.
 *
 * Runtime mode is intentionally not inherited from whatever thread happens to
 * be visible. Existing threads keep their persisted mode; only a caller that is
 * explicitly creating a new thread can override the Full access default.
 */
export function resolveNewThreadRuntimeMode(explicitMode?: RuntimeMode): RuntimeMode {
  return explicitMode ?? DEFAULT_RUNTIME_MODE;
}
