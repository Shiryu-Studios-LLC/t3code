import type { ShiryuGenCharacterKit } from "./shiryuGenProductionStore";

export interface ShiryuGenGenerationIdentity {
  presentation: "male" | "female" | "other" | "unspecified";
  species: string;
  age: number | null;
  lifeStage: "adult" | "young-adult" | "unspecified";
  classification: "student" | "non-student";
  visibleMagic: "allowed" | "none";
}

/** Only legacy migration reads prose. Rendering uses the saved, editable identity. */
export function migrateGenerationIdentity(
  character: ShiryuGenCharacterKit,
): ShiryuGenGenerationIdentity {
  if (character.generationIdentity) return { ...character.generationIdentity };
  const text = [
    character.role,
    character.description,
    character.visualTraits,
    character.canonicalRules,
  ].join(" ");
  const male = /\b(male|man|boy|schoolboy)\b/i.test(text);
  const female = /\b(female|woman|girl|schoolgirl|heroine)\b/i.test(text);
  const student = /\b(student|first[- ]year|freshman|schoolboy|schoolgirl|classmate)\b/i.test(text);
  const ageMatch = text.match(/\b(?:(\d{1,2})[- ]year[- ]old|age\s+(\d{1,2}))\b/i);
  const age = ageMatch ? Number(ageMatch[1] ?? ageMatch[2]) : student ? 18 : null;
  return {
    presentation: male !== female ? (male ? "male" : "female") : "unspecified",
    species: /\b(kitsune|fox ears)\b/i.test(text)
      ? "kitsune"
      : /\b(furry|anthro|anthropomorphic)\b/i.test(text)
        ? "anthropomorphic"
        : "human",
    age,
    lifeStage: student ? "young-adult" : age !== null && age >= 18 ? "adult" : "unspecified",
    classification: student ? "student" : "non-student",
    visibleMagic:
      /\b(zero[- ]magic|zero magical power|no (?:visible )?magic|no magical power|non[- ]magical|cannot cast magic|no aura|no glowing eyes)\b/i.test(
        text,
      )
        ? "none"
        : "allowed",
  };
}
