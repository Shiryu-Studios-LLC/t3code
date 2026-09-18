import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { formatShiryuGenPromptWithLocalModel } from "./ShiryuGenPromptFormatter.ts";

it.effect("first canon references never contact Ollama", () =>
  formatShiryuGenPromptWithLocalModel({
    sceneMode: "first-canon-reference",
    modelProfile: { id: "nova-anime-illustrious", label: "Nova Anime", promptStyle: "tag" },
    lockedFacts: [],
    requiredConcepts: [],
    optionalConcepts: [],
    forbiddenConcepts: [],
    requiredTags: [],
    optionalTags: [],
    forbiddenTags: [],
    userSceneRequest: "reference",
    styleRequirements: [],
    deterministicPositivePrompt: "1boy, navy jacket",
    deterministicNegativePrompt: "white jacket",
  }).pipe(
    Effect.provide(ServerSettingsService.layerTest()),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("First references must not contact Ollama")),
    ),
    Effect.map((result) =>
      expect(result).toEqual({
        positivePrompt: "1boy, navy jacket",
        negativePrompt: "white jacket",
        formatterModel: "deterministic canon compiler",
        warnings: [],
        usedFallback: false,
      }),
    ),
  ),
);
