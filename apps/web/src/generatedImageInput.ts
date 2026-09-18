import type { ChatImageAttachment, LocalImageGenerateInput, ThreadId } from "@t3tools/contracts";

/** Reuse the saved renderer inputs so toolbar actions cannot pick up unrelated globals. */
export function buildGeneratedImageInput(
  threadId: ThreadId,
  image: ChatImageAttachment,
  instruction?: string,
): LocalImageGenerateInput | null {
  const details = image.generationDetails;
  const editing = instruction !== undefined;
  const prompt = editing
    ? instruction.trim()
    : details?.positivePrompt || image.generationPrompt?.trim();
  if (!prompt) return null;
  return {
    threadId,
    prompt,
    requestText: editing ? `Edit image: ${prompt}` : "Regenerate image",
    skipPromptRefinement: !editing,
    ...(editing
      ? { referenceAttachmentId: image.id }
      : details?.referenceAttachmentId
        ? { referenceAttachmentId: details.referenceAttachmentId }
        : {}),
    ...(details
      ? {
          model: "custom" as const,
          checkpointPath: details.checkpoint,
          negativePrompt: details.negativePrompt,
          width: details.width,
          height: details.height,
          steps: details.steps,
          guidance: details.guidance,
          sampler: details.sampler,
          scheduler: details.scheduler,
          loras: details.loras,
          ...(!editing &&
          details.character &&
          details.sceneMode &&
          details.modelProfile &&
          details.policyVersion
            ? {
                shiryuGenMetadata: {
                  character: details.character,
                  sceneMode: details.sceneMode,
                  modelProfile: details.modelProfile,
                  policyVersion: details.policyVersion,
                  referenceState: details.referenceState ?? "none",
                  ...(details.formatterModel !== undefined
                    ? { formatterModel: details.formatterModel }
                    : {}),
                  ...(details.formatterFallback !== undefined
                    ? { formatterFallback: details.formatterFallback }
                    : {}),
                  ...(details.promptSource !== undefined
                    ? { promptSource: details.promptSource }
                    : {}),
                },
              }
            : {}),
        }
      : {}),
  };
}
