import type { McpServerConfig } from "@t3tools/contracts";

export type PluginCapability =
  | "email"
  | "image-generation"
  | "calendar"
  | "messaging"
  | "cloud-files"
  | "documents"
  | "source-control"
  | "project-management"
  | "finance";

export interface PluginPromptContextResult {
  readonly prompt: string;
  readonly activated: boolean;
  readonly matchedPluginNames: ReadonlyArray<string>;
  readonly requiredCapabilities: ReadonlyArray<PluginCapability>;
  readonly reason: "explicit" | "capability" | "connected-app" | null;
}

const EXPLICIT_PLUGIN_INTENT =
  /\b(?:plugin|plugins|mcp|connector|connectors|integration|integrations|connected app|connected apps|tool server|tool servers)\b/i;

const CONNECTED_APP_INTENT =
  /\b(?:check|read|search|send|reply|forward|draft|schedule|reschedule|cancel|create|update|post|message|upload|download|sync|fetch|find|list|review|share)\b[\s\S]{0,48}\b(?:gmail|outlook|calendar|slack|discord|teams|notion|drive|dropbox|onedrive|github|gitlab|jira|linear|bank|banking|brokerage|portfolio|crm)\b|\b(?:gmail|outlook|calendar|slack|discord|teams|notion|dropbox|onedrive|github|gitlab|jira|linear|banking|brokerage|crm)\b[\s\S]{0,48}\b(?:check|read|search|send|reply|forward|draft|schedule|create|update|post|message|upload|download|sync|fetch|find|list|review|share)\b/i;

interface CapabilityRule {
  readonly capability: PluginCapability;
  readonly label: string;
  readonly patterns: ReadonlyArray<RegExp>;
  readonly serverHints: ReadonlyArray<string>;
}

const CAPABILITY_RULES: ReadonlyArray<CapabilityRule> = [
  {
    capability: "email",
    label: "email",
    patterns: [
      /\b(?:send|reply|forward)\b[\s\S]{0,36}\b(?:an?\s+)?(?:email|e-mail|mail)\b/i,
      /\bemail\b[\s\S]{0,24}\b(?:to|about|regarding)\b/i,
      /\b(?:check|read|search|find|show|open)\b[\s\S]{0,36}\b(?:my\s+)?(?:email|e-mail|mail|inbox)\b/i,
      /\b(?:gmail|outlook)\b/i,
      /\b(?:create|save|make)\b[\s\S]{0,36}\b(?:email\s+)?draft\b/i,
    ],
    serverHints: ["gmail", "outlook", "email", "mail"],
  },
  {
    capability: "image-generation",
    label: "image generation",
    patterns: [
      /\b(?:generate|create|make|draw|render|design|illustrate|visualize)\b[\s\S]{0,48}\b(?:image|picture|photo|artwork|illustration|logo|icon|wallpaper|poster|avatar|graphic)\b/i,
      /\b(?:image|picture|photo|artwork|illustration|logo|icon|wallpaper|poster|avatar|graphic)\b[\s\S]{0,48}\b(?:generate|create|make|draw|render|design|illustrate)\b/i,
    ],
    serverHints: [
      "image",
      "images",
      "dall-e",
      "dalle",
      "midjourney",
      "stability",
      "stable diffusion",
      "flux",
      "ideogram",
    ],
  },
  {
    capability: "calendar",
    label: "calendar",
    patterns: [
      /\b(?:schedule|reschedule|cancel|book|move|create|add)\b[\s\S]{0,48}\b(?:meeting|appointment|event|calendar)\b/i,
      /\b(?:check|show|read|search|find|open)\b[\s\S]{0,36}\b(?:my\s+)?calendar\b/i,
      /\b(?:google calendar|outlook calendar)\b/i,
    ],
    serverHints: ["calendar", "google calendar", "outlook"],
  },
  {
    capability: "messaging",
    label: "messaging",
    patterns: [
      /\b(?:send|post|reply|message|dm)\b[\s\S]{0,48}\b(?:slack|discord|teams|channel|workspace)\b/i,
      /\b(?:slack|discord|teams)\b[\s\S]{0,48}\b(?:send|post|reply|message|search|read|check)\b/i,
    ],
    serverHints: ["slack", "discord", "teams", "messaging", "chat"],
  },
  {
    capability: "cloud-files",
    label: "cloud files",
    patterns: [
      /\b(?:upload|download|find|search|read|open|share|move|copy|list)\b[\s\S]{0,48}\b(?:google drive|drive|dropbox|onedrive|cloud files?)\b/i,
      /\b(?:google drive|dropbox|onedrive)\b/i,
    ],
    serverHints: ["drive", "google drive", "dropbox", "onedrive", "cloud"],
  },
  {
    capability: "documents",
    label: "connected documents",
    patterns: [
      /\b(?:create|edit|update|read|search|find|share)\b[\s\S]{0,48}\b(?:google docs?|google sheets?|notion|airtable)\b/i,
      /\b(?:google docs?|google sheets?|notion|airtable)\b/i,
    ],
    serverHints: ["docs", "sheets", "notion", "airtable"],
  },
  {
    capability: "source-control",
    label: "source control hosting",
    patterns: [
      /\b(?:github|gitlab|bitbucket)\b/i,
      /\b(?:create|open|review|merge|close|comment on)\b[\s\S]{0,48}\b(?:pull request|merge request|github issue|gitlab issue)\b/i,
    ],
    serverHints: ["github", "gitlab", "bitbucket"],
  },
  {
    capability: "project-management",
    label: "project management",
    patterns: [
      /\b(?:jira|linear|asana|trello)\b/i,
      /\b(?:create|update|move|assign|close|search|find)\b[\s\S]{0,48}\b(?:jira|linear|asana|trello|ticket)\b/i,
    ],
    serverHints: ["jira", "linear", "asana", "trello"],
  },
  {
    capability: "finance",
    label: "financial account data",
    patterns: [
      /\b(?:check|show|read|search|find|review|categorize)\b[\s\S]{0,48}\b(?:bank|banking|transaction|transactions|brokerage|portfolio|account balance|spending)\b/i,
      /\b(?:banking|brokerage|portfolio|transactions?)\b[\s\S]{0,48}\b(?:check|show|read|search|find|review|categorize)\b/i,
    ],
    serverHints: ["finance", "bank", "banking", "brokerage", "portfolio"],
  },
];

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function includesServerName(prompt: string, server: McpServerConfig): boolean {
  const name = server.name.trim().toLowerCase();
  if (name.length < 3) return false;
  return prompt.toLowerCase().includes(name);
}

function inferRequiredCapabilities(userPrompt: string): ReadonlyArray<CapabilityRule> {
  return CAPABILITY_RULES.filter((rule) =>
    rule.patterns.some((pattern) => pattern.test(userPrompt)),
  );
}

function serverMatchesCapability(server: McpServerConfig, rule: CapabilityRule): boolean {
  const haystack = normalize(`${server.id} ${server.name}`);
  return rule.serverHints.some((hint) => haystack.includes(normalize(hint)));
}

export function buildPluginPromptContext(
  userPrompt: string,
  servers: ReadonlyArray<McpServerConfig>,
  providerPrompt: string = userPrompt,
): PluginPromptContextResult {
  const enabledServers = servers.filter((server) => server.enabled !== false);
  const directlyNamedServers = enabledServers.filter((server) =>
    includesServerName(userPrompt, server),
  );
  const capabilityRules = inferRequiredCapabilities(userPrompt);
  const capabilityMatchedServers = enabledServers.filter((server) =>
    capabilityRules.some((rule) => serverMatchesCapability(server, rule)),
  );
  const matchedPluginNames = [
    ...new Set([...directlyNamedServers, ...capabilityMatchedServers].map((server) => server.name)),
  ];
  const requiredCapabilities = capabilityRules.map((rule) => rule.capability);
  const explicit = EXPLICIT_PLUGIN_INTENT.test(userPrompt) || directlyNamedServers.length > 0;
  const capability = capabilityRules.length > 0;
  const connectedApp = CONNECTED_APP_INTENT.test(userPrompt);
  const activated = explicit || capability || connectedApp;

  if (!activated) {
    return {
      prompt: providerPrompt,
      activated: false,
      matchedPluginNames: [],
      requiredCapabilities: [],
      reason: null,
    };
  }

  const capabilityLabels = capabilityRules.map((rule) => rule.label);
  const hasBuiltInLocalImageGeneration = requiredCapabilities.includes("image-generation");
  const capabilityHint =
    capabilityLabels.length > 0 ? ` Likely capability: ${capabilityLabels.join(", ")}.` : "";
  const pluginHint =
    matchedPluginNames.length > 0
      ? ` Matching enabled plugin: ${matchedPluginNames.join(", ")}.`
      : "";
  const imageHint = hasBuiltInLocalImageGeneration
    ? " For image creation prefer the built-in local `t3_generate_image` capability."
    : "";

  const prompt = `[ShiryuGen tools]\nUse visible tools directly. If a needed capability is not visible, call \`shiryugen_tool_search\`; it can activate Swarm, images, plugins, skills, previews, workspace tools, and connected integrations.${capabilityHint}${pluginHint}${imageHint}\n\n[User request]\n${providerPrompt}`;

  return {
    prompt,
    activated: true,
    matchedPluginNames,
    requiredCapabilities,
    reason: explicit ? "explicit" : capability ? "capability" : "connected-app",
  };
}
