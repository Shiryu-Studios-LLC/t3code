import type { EnvironmentId } from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  FileImageIcon,
  ImagePlusIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { ChatImageAttachment } from "../../types";
import {
  useShiryuGenProductionStore,
  type ShiryuGenAssetStatus,
} from "../../shiryuGenProductionStore";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

const REFERENCE_STATUSES: ReadonlyArray<{
  value: ShiryuGenAssetStatus;
  label: string;
  description: string;
  icon: typeof FileImageIcon;
}> = [
  {
    value: "draft",
    label: "Draft",
    description: "Keep it for review. It will not guide future generations yet.",
    icon: FileImageIcon,
  },
  {
    value: "approved",
    label: "Approved",
    description: "Good supporting reference that ShiryuGen may reuse.",
    icon: CheckCircle2Icon,
  },
  {
    value: "canon",
    label: "Canon",
    description: "Identity-defining reference. Use only when the design is correct.",
    icon: ShieldCheckIcon,
  },
  {
    value: "rejected",
    label: "Rejected",
    description: "Keep the image in history but exclude it from continuity.",
    icon: XCircleIcon,
  },
];

interface AddGeneratedImageToCharacterDialogProps {
  image: ChatImageAttachment;
  environmentId: EnvironmentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddGeneratedImageToCharacterDialog({
  image,
  environmentId,
  open,
  onOpenChange,
}: AddGeneratedImageToCharacterDialogProps) {
  const series = useShiryuGenProductionStore((state) => state.series);
  const characters = useShiryuGenProductionStore((state) => state.characters);
  const activeSeriesId = useShiryuGenProductionStore((state) => state.activeSeriesId);
  const setActiveSeries = useShiryuGenProductionStore((state) => state.setActiveSeries);
  const addReferenceAsset = useShiryuGenProductionStore((state) => state.addReferenceAsset);

  const fallbackSeriesId =
    (activeSeriesId && series.some((entry) => entry.id === activeSeriesId)
      ? activeSeriesId
      : null) ??
    series[0]?.id ??
    "";
  const [seriesId, setSeriesId] = useState(fallbackSeriesId);
  const seriesCharacters = useMemo(
    () => characters.filter((character) => character.seriesId === seriesId),
    [characters, seriesId],
  );
  const [characterId, setCharacterId] = useState(seriesCharacters[0]?.id ?? "");
  const [status, setStatus] = useState<ShiryuGenAssetStatus>("draft");

  useEffect(() => {
    if (!open) return;
    const nextSeriesId =
      (activeSeriesId && series.some((entry) => entry.id === activeSeriesId)
        ? activeSeriesId
        : null) ??
      series[0]?.id ??
      "";
    setSeriesId(nextSeriesId);
    const firstCharacter = characters.find((character) => character.seriesId === nextSeriesId);
    setCharacterId(firstCharacter?.id ?? "");
    setStatus("draft");
  }, [activeSeriesId, characters, open, series]);

  useEffect(() => {
    if (!seriesId) {
      setCharacterId("");
      return;
    }
    if (seriesCharacters.some((character) => character.id === characterId)) return;
    setCharacterId(seriesCharacters[0]?.id ?? "");
  }, [characterId, seriesCharacters, seriesId]);

  const selectedCharacter = characters.find((character) => character.id === characterId) ?? null;
  const selectedStatus = REFERENCE_STATUSES.find((entry) => entry.value === status)!;
  const canSave = Boolean(seriesId && selectedCharacter);

  const saveReference = () => {
    if (!selectedCharacter) return;
    addReferenceAsset({
      characterId: selectedCharacter.id,
      name: image.name,
      source: image.previewUrl ?? image.savedPath ?? "",
      status,
      sourceKind: "chat-attachment",
      environmentId,
      attachmentId: image.id,
      ...(image.savedPath ? { savedPath: image.savedPath } : {}),
      ...(image.generationPrompt ? { generationPrompt: image.generationPrompt } : {}),
      ...(image.generationTool ? { generationTool: image.generationTool } : {}),
    });
    setActiveSeries(selectedCharacter.seriesId);
    onOpenChange(false);
    toastManager.add({
      type: "success",
      title:
        status === "canon"
          ? "Canon reference saved"
          : status === "approved"
            ? "Approved reference saved"
            : "Image added to Character Kit",
      description: `${image.name} → ${selectedCharacter.name}`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImagePlusIcon className="size-4" />
            Add generated image to Character Kit
          </DialogTitle>
          <DialogDescription>
            Choose who this image belongs to and whether it is still being reviewed or should become
            part of the character&apos;s continuity.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <div className="aspect-[4/5] overflow-hidden rounded-xl border border-border/70 bg-muted/20">
              {image.previewUrl ? (
                <img
                  src={image.previewUrl}
                  alt={image.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <ImagePlusIcon className="size-7 text-muted-foreground" />
                </div>
              )}
            </div>
            <div className="min-w-0 self-center">
              <div className="truncate text-sm font-semibold">{image.name}</div>
              <div className="mt-2 line-clamp-4 text-xs leading-5 text-muted-foreground">
                {image.generationPrompt ?? "Generated ShiryuGen image"}
              </div>
              {image.savedPath ? (
                <div className="mt-2 truncate text-[11px] text-muted-foreground">
                  {image.savedPath}
                </div>
              ) : null}
            </div>
          </div>

          {series.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 p-5 text-sm text-muted-foreground">
              Create a Series and at least one Character Kit from the Series Board before attaching
              generated references.
            </div>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Series</Label>
                  <Select
                    value={seriesId}
                    onValueChange={(value) => {
                      setSeriesId(value ?? "");
                    }}
                  >
                    <SelectTrigger aria-label="Series">
                      <SelectValue>
                        {series.find((entry) => entry.id === seriesId)?.title ?? "Choose series"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {series.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>Character</Label>
                  {seriesCharacters.length > 0 ? (
                    <Select
                      value={characterId}
                      onValueChange={(value) => {
                        setCharacterId(value ?? "");
                      }}
                    >
                      <SelectTrigger aria-label="Character">
                        <SelectValue>{selectedCharacter?.name ?? "Choose character"}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {seriesCharacters.map((character) => (
                          <SelectItem key={character.id} value={character.id}>
                            {character.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : (
                    <div className="rounded-lg border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                      This Series does not have a Character Kit yet.
                    </div>
                  )}
                </div>
              </div>

              <div>
                <Label>Continuity status</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Start with Draft when you are still checking the design. Promote it to Canon only
                  when you want future generations to treat it as identity-defining.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {REFERENCE_STATUSES.map((entry) => {
                    const Icon = entry.icon;
                    const selected = status === entry.value;
                    return (
                      <button
                        key={entry.value}
                        type="button"
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          selected
                            ? "border-primary/55 bg-primary/10 ring-1 ring-primary/20"
                            : "border-border/70 bg-background/30 hover:bg-muted/25"
                        }`}
                        onClick={() => setStatus(entry.value)}
                      >
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <Icon className="size-4" /> {entry.label}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          {entry.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {selectedCharacter ? (
                <div className="rounded-xl border border-border/60 bg-muted/10 p-3 text-xs text-muted-foreground">
                  This will save the original durable chat attachment for{" "}
                  <strong>{selectedCharacter.name}</strong> as
                  <strong> {selectedStatus.label}</strong>.
                </div>
              ) : null}
            </>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={!canSave} onClick={saveReference}>
            {status === "canon" ? (
              <ShieldCheckIcon className="size-4" />
            ) : (
              <ImagePlusIcon className="size-4" />
            )}
            {status === "canon" ? "Save as Canon" : `Add as ${selectedStatus.label}`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
