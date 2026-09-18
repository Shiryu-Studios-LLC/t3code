import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, ".t3"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly joinPath: JoinPath;
}): string {
  // ShiryuGen intentionally shares one desktop profile between development
  // and packaged builds. Keeping both channels on `userdata` means chats,
  // settings, generated-image metadata, and other server-backed state remain
  // available when switching between Alpha and Dev. The Electron userData
  // directory is shared separately so renderer-local state follows too.
  return input.joinPath(input.baseDir, "userdata");
}
