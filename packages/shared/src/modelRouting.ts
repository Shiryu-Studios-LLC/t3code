import type {
  AgentRole,
  CostPolicy,
  CostTier,
  ModelCapabilities,
  ModelCapabilityTag,
} from "@t3tools/contracts";

export const ROLE_DEFAULT_CAPABILITIES: Record<AgentRole, ReadonlyArray<ModelCapabilityTag>> = {
  orchestrator: ["reasoning", "tool_calling", "structured_output", "large_context"],
  coder: ["coding", "tool_calling", "structured_output"],
  vision: ["vision_input", "reasoning"],
  image_generator: ["image_generation"],
  video_generator: ["video_generation"],
  audio_generator: ["audio_generation"],
  speech_to_text: ["speech_to_text"],
  researcher: ["reasoning", "tool_calling", "large_context"],
  reviewer: ["reasoning", "coding"],
  custom: [],
};

export interface RolePresentation {
  readonly label: string;
  readonly emoji: string;
  readonly description: string;
}

export const ROLE_PRESENTATION: Record<AgentRole, RolePresentation> = {
  orchestrator: {
    label: "Orchestrator",
    emoji: "🧠",
    description: "Lead reasoning brain that coordinates work, tasks, and delegates to specialists.",
  },
  coder: {
    label: "Coder",
    emoji: "💻",
    description: "Specialized in software engineering, refactoring, and tool execution.",
  },
  vision: {
    label: "Vision",
    emoji: "👁️",
    description: "Multimodal inspection of screenshots, UI mockups, and diagrams.",
  },
  image_generator: {
    label: "Image Gen",
    emoji: "🎨",
    description: "Generates concept artwork, textures, icons, and UI assets.",
  },
  video_generator: {
    label: "Video Gen",
    emoji: "🎬",
    description: "Produces video clips, animations, and promotional previews.",
  },
  audio_generator: {
    label: "Audio / TTS",
    emoji: "🎙️",
    description: "Synthesizes speech, sound effects, and voice commentary.",
  },
  speech_to_text: {
    label: "Transcriber",
    emoji: "📝",
    description: "Converts voice input and audio assets into text.",
  },
  researcher: {
    label: "Researcher",
    emoji: "🔬",
    description: "Deep web, documentation, and codebase analysis.",
  },
  reviewer: {
    label: "Reviewer",
    emoji: "🔍",
    description: "Validates pull requests, checks diffs, and ensures test compliance.",
  },
  custom: {
    label: "Specialist",
    emoji: "⚡",
    description: "Custom agent with flexible capability requirements.",
  },
};

/**
 * Checks if a model's capabilities satisfy all required capability tags.
 */
export function modelSatisfiesCapabilities(
  capabilities: ModelCapabilities | null | undefined,
  required: ReadonlyArray<ModelCapabilityTag>,
): boolean {
  if (required.length === 0) return true;
  if (!capabilities) return false;

  const tags = new Set<ModelCapabilityTag>(capabilities.tags ?? []);

  // Map boolean fields to tags if present
  if (capabilities.reasoning) tags.add("reasoning");
  if (capabilities.coding) tags.add("coding");
  if (capabilities.imageInput) tags.add("vision_input");
  if (capabilities.audioInput) tags.add("audio_input");
  if (capabilities.videoInput) tags.add("video_input");
  if (capabilities.imageOutput) tags.add("image_generation");
  if (capabilities.videoOutput) tags.add("video_generation");
  if (capabilities.audioOutput) tags.add("audio_generation");
  if (capabilities.toolCalling) tags.add("tool_calling");
  if (capabilities.structuredOutput) tags.add("structured_output");
  if (capabilities.contextWindow && capabilities.contextWindow >= 100_000) {
    tags.add("large_context");
  }

  for (const req of required) {
    if (!tags.has(req)) return false;
  }

  return true;
}

/**
 * Evaluates whether a model conforms to a cost policy.
 */
export function isCostPolicyAllowed(
  costTier: CostTier | undefined,
  isFree: boolean | undefined,
  policy: CostPolicy,
): boolean {
  if (policy === "unrestricted" || policy === "prefer_free") {
    return true;
  }
  if (policy === "free_only") {
    return isFree === true || costTier === "free";
  }
  return true;
}

/**
 * Calculates a matching score for ranking candidate models (higher is better).
 */
export function calculateModelRankScore(options: {
  capabilities: ModelCapabilities | null | undefined;
  required: ReadonlyArray<ModelCapabilityTag>;
  costPolicy: CostPolicy;
  isPreferredProvider?: boolean;
  isPreferredModel?: boolean;
}): number {
  let score = 100;

  const isFree = options.capabilities?.free === true || options.capabilities?.costTier === "free";

  if (options.costPolicy === "free_only") {
    if (!isFree) return -1000;
    score += 500;
  } else if (options.costPolicy === "prefer_free") {
    if (isFree) score += 300;
  }

  if (options.isPreferredProvider) score += 50;
  if (options.isPreferredModel) score += 100;

  if (options.capabilities?.contextWindow) {
    // Slight bonus for larger context windows
    score += Math.min(Math.floor(options.capabilities.contextWindow / 10_000), 50);
  }

  return score;
}
