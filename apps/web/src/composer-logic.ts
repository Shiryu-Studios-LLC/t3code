import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export type ComposerTriggerKind = "path" | "slash-command" | "skill";
export type ComposerSlashCommand =
  | "model"
  | "plan"
  | "default"
  | "new"
  | "project"
  | "plugins"
  | "skills"
  | "settings"
  | "image"
  | "help";
export type ComposerSubmissionIntent = "foreground" | "background";
export type ComposerTurnDelivery = "auto" | "steer" | "queue";

export interface ComposerSlashCommandDefinition {
  readonly command: ComposerSlashCommand;
  readonly label: string;
  readonly description: string;
  readonly requiresPlanMode?: boolean;
}

export const T3_COMPOSER_SLASH_COMMANDS: ReadonlyArray<ComposerSlashCommandDefinition> = [
  { command: "model", label: "/model", description: "Switch response model for this thread" },
  { command: "new", label: "/new", description: "Start a new General Chat" },
  { command: "project", label: "/project", description: "Choose a project for a new project chat" },
  { command: "plugins", label: "/plugins", description: "Open Plugins & Apps settings" },
  { command: "skills", label: "/skills", description: "Open T3 Skills settings" },
  { command: "settings", label: "/settings", description: "Open T3 Studio settings" },
  { command: "image", label: "/image", description: "Generate an image locally with T3" },
  { command: "help", label: "/help", description: "Show T3 slash command help" },
  {
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
    requiresPlanMode: true,
  },
  {
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal build mode",
    requiresPlanMode: true,
  },
];

export interface DirectLocalImageRequest {
  readonly prompt: string;
  readonly source: "slash" | "natural" | "edit";
  readonly usePreviousImage: boolean;
}

const NATURAL_IMAGE_CREATE_PATTERN =
  /\b(?:create|generate|draw|render|design|produce)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|artwork|render|logo|poster|wallpaper)\b|\bmake\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|artwork|render|logo|poster|wallpaper)\b|^(?:image|picture|photo)\s+of\b/i;
const NATURAL_VISUAL_SUBJECT_CREATE_PATTERN =
  /\b(?:create|generate|draw|render|design|produce|make)\s+(?:me\s+)?(?:an?\s+)?(?=[\s\S]{0,140}\b(?:character|portrait|avatar|pose|scene|creature|mascot|concept\s+art|kitsune|furry|anthro|anthropomorphic|dog|canine|fox|wolf|cat|feline|monster)\b)/i;
const NON_IMAGE_CREATION_CONTEXT_PATTERN =
  /\b(?:typescript|javascript|python|rust|golang|c\+\+|c#|class|function|method|component|page|route|api|endpoint|database|schema|code|script|app|application|website|frontend|backend|settings|form|button|plugin|service|server|test|unity|unreal|blender|project|repository|repo)\b/i;
const IMAGE_EDIT_FOLLOW_UP_PATTERN =
  /^(?:please\s+)?(?:make|change|turn|edit|adjust|modify|recolor|restyle|add|remove|replace)\s+(?:it|this|that|the\s+(?:image|picture|photo)|(?:a|an|the)\s+)/i;

export function resolveDirectLocalImageRequest(input: {
  readonly text: string;
  readonly preferLocalImageGeneration: boolean;
  readonly hasGeneratedImage: boolean;
}): DirectLocalImageRequest | null {
  const text = input.text.trim();
  const slash = /^\/image(?:\s+([\s\S]+))?$/i.exec(text);
  if (slash) {
    const prompt = slash[1]?.trim() ?? "";
    if (!prompt) return null;
    return {
      prompt,
      source: "slash",
      usePreviousImage: input.hasGeneratedImage && IMAGE_EDIT_FOLLOW_UP_PATTERN.test(prompt),
    };
  }
  if (!input.preferLocalImageGeneration || !text) return null;
  if (
    NATURAL_IMAGE_CREATE_PATTERN.test(text) ||
    (NATURAL_VISUAL_SUBJECT_CREATE_PATTERN.test(text) &&
      !NON_IMAGE_CREATION_CONTEXT_PATTERN.test(text))
  ) {
    return { prompt: text, source: "natural", usePreviousImage: false };
  }
  if (input.hasGeneratedImage && IMAGE_EDIT_FOLLOW_UP_PATTERN.test(text)) {
    return { prompt: text, source: "edit", usePreviousImage: true };
  }
  return null;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function composerSubmissionIntentForEnter(input: {
  isMobileViewport: boolean;
  shiftKey: boolean;
  modifierKey: boolean;
  isDraftThread: boolean;
}): ComposerSubmissionIntent | null {
  if (input.isMobileViewport || input.shiftKey) {
    return null;
  }
  return input.modifierKey && input.isDraftThread ? "background" : "foreground";
}

const isInlineTokenSegment = (
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER
  );
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return expandedCursor + remaining;
      }
      remaining -= 1;
      expandedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" }
  >,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.source.length;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return collapsedCursor + remaining;
      }
      remaining -= 1;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export const isCollapsedCursorAdjacentToMention = isCollapsedCursorAdjacentToInlineToken;

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(text: string): ComposerSlashCommand | null {
  const match = /^\/([a-z-]+)\s*$/i.exec(text.trim());
  if (!match) return null;
  const command = match[1]?.toLowerCase();
  const definition = T3_COMPOSER_SLASH_COMMANDS.find((entry) => entry.command === command);
  return definition?.command ?? null;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
