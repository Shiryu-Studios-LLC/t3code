import type { T3SkillConfig } from "@t3tools/contracts";

const SKILL_TOKEN = /(^|[\s([{])\$([A-Za-z0-9_-]+)(?=$|[\s,.;:!?\])}])/g;

export interface ExpandedT3SkillPrompt {
  readonly prompt: string;
  readonly activatedSkillNames: ReadonlyArray<string>;
}

/**
 * Expands environment-owned T3 skills into provider-neutral instructions.
 * Unknown tokens are intentionally left untouched so provider-native skills
 * keep their normal `$skill-name` semantics.
 */
export function expandT3SkillsInPrompt(
  prompt: string,
  skills: ReadonlyArray<T3SkillConfig>,
): ExpandedT3SkillPrompt {
  const enabledByName = new Map(
    skills
      .filter((skill) => skill.enabled)
      .map((skill) => [skill.name.trim().toLowerCase(), skill] as const),
  );
  const activated = new Map<string, T3SkillConfig>();

  const userPrompt = prompt.replace(SKILL_TOKEN, (match, prefix: string, rawName: string) => {
    const skill = enabledByName.get(rawName.toLowerCase());
    if (!skill) return match;
    activated.set(skill.name.toLowerCase(), skill);
    return `${prefix}[${skill.displayName}]`;
  });

  if (activated.size === 0) {
    return { prompt, activatedSkillNames: [] };
  }

  const skillInstructions = [...activated.values()]
    .map(
      (skill) =>
        `### ${skill.displayName}\n${skill.description ? `${skill.description.trim()}\n` : ""}${skill.instructions.trim()}`,
    )
    .join("\n\n");

  return {
    prompt: `[T3 Studio skills activated]\nFollow these reusable workflow instructions for this turn. They supplement the user's request and do not override higher-priority system or safety instructions.\n\n${skillInstructions}\n\n[User request]\n${userPrompt}`,
    activatedSkillNames: [...activated.values()].map((skill) => skill.name),
  };
}
