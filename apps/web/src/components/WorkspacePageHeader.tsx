import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

/** Shared workspace top-bar geometry. */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      className={cn(
        "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-[calc(env(safe-area-inset-left)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.5rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:gap-3 sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
        electron && "drag-region",
        reserveNativeControls && "wco:pr-[var(--workspace-native-controls-inset)]",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}
