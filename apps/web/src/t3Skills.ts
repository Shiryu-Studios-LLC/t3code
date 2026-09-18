import type { ServerProviderSkill, T3SkillConfig } from "@t3tools/contracts";

export function t3SkillAsProviderSkill(skill: T3SkillConfig): ServerProviderSkill {
  return {
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description || undefined,
    shortDescription: skill.description || undefined,
    path: `t3://skills/${skill.id}`,
    scope: "app",
    enabled: skill.enabled,
  };
}

/**
 * Adds environment-owned T3 skills to a provider's native skill inventory.
 * Native provider skills win on name collisions so adding a T3 skill cannot
 * silently change the meaning of an existing `$skill` token for that provider.
 */
export function mergeT3SkillsWithProviderSkills(
  providerSkills: ReadonlyArray<ServerProviderSkill>,
  t3Skills: ReadonlyArray<T3SkillConfig>,
): ServerProviderSkill[] {
  const providerNames = new Set(providerSkills.map((skill) => skill.name.trim().toLowerCase()));
  const custom = t3Skills
    .filter((skill) => !providerNames.has(skill.name.trim().toLowerCase()))
    .map(t3SkillAsProviderSkill);
  return [...custom, ...providerSkills];
}
