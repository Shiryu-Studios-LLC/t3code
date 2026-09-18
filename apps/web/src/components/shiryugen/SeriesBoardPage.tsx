import {
  Columns2Icon,
  FilmIcon,
  ImageIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UsersRoundIcon,
} from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import {
  selectCharacterCoverAsset,
  useShiryuGenProductionStore,
  type ShiryuGenAssetStatus,
} from "../../shiryuGenProductionStore";
import { isElectron } from "../../env";
import { CharacterGenerationPanel } from "./CharacterGenerationPanel";
import { ReferenceAssetPreview } from "./ReferenceAssetPreview";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const assetStatuses: ShiryuGenAssetStatus[] = ["draft", "approved", "canon", "rejected"];

export function SeriesBoardPage() {
  const series = useShiryuGenProductionStore((state) => state.series);
  const characters = useShiryuGenProductionStore((state) => state.characters);
  const activeSeriesId = useShiryuGenProductionStore((state) => state.activeSeriesId);
  const setActiveSeries = useShiryuGenProductionStore((state) => state.setActiveSeries);
  const createSeries = useShiryuGenProductionStore((state) => state.createSeries);
  const createCharacter = useShiryuGenProductionStore((state) => state.createCharacter);
  const removeCharacter = useShiryuGenProductionStore((state) => state.removeCharacter);
  const addReferenceAsset = useShiryuGenProductionStore((state) => state.addReferenceAsset);
  const setReferenceAssetStatus = useShiryuGenProductionStore(
    (state) => state.setReferenceAssetStatus,
  );

  const [seriesDialogOpen, setSeriesDialogOpen] = useState(false);
  const [characterDialogOpen, setCharacterDialogOpen] = useState(false);
  const [assetCharacterId, setAssetCharacterId] = useState<string | null>(null);
  const [selectedGenerationCharacterId, setSelectedGenerationCharacterId] = useState<string | null>(
    null,
  );
  const [compareCharacterId, setCompareCharacterId] = useState<string | null>(null);
  const [seriesTitle, setSeriesTitle] = useState("");
  const [seriesDescription, setSeriesDescription] = useState("");
  const [seriesStyle, setSeriesStyle] = useState("");
  const [characterName, setCharacterName] = useState("");
  const [characterRole, setCharacterRole] = useState("");
  const [characterTraits, setCharacterTraits] = useState("");
  const [characterRules, setCharacterRules] = useState("");
  const [characterOutfits, setCharacterOutfits] = useState("");
  const [assetName, setAssetName] = useState("");
  const [assetSource, setAssetSource] = useState("");

  const activeSeries = series.find((entry) => entry.id === activeSeriesId) ?? series[0] ?? null;
  const activeCharacters = useMemo(
    () => characters.filter((character) => character.seriesId === activeSeries?.id),
    [activeSeries?.id, characters],
  );
  const effectiveGenerationCharacterId = activeCharacters.some(
    (character) => character.id === selectedGenerationCharacterId,
  )
    ? selectedGenerationCharacterId
    : (activeCharacters[0]?.id ?? null);
  const compareCharacter =
    activeCharacters.find((character) => character.id === compareCharacterId) ?? null;
  const compareReferences = compareCharacter
    ? compareCharacter.referenceAssets.filter(
        (asset) => asset.status === "canon" || asset.status === "approved",
      )
    : [];
  const selectCharacterForGeneration = (characterId: string) => {
    setSelectedGenerationCharacterId(characterId);
    window.requestAnimationFrame(() => {
      document
        .getElementById("character-generation-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };
  const canonCount = activeCharacters.reduce(
    (count, character) =>
      count + character.referenceAssets.filter((asset) => asset.status === "canon").length,
    0,
  );
  const referenceCount = activeCharacters.reduce(
    (count, character) => count + character.referenceAssets.length,
    0,
  );

  const submitSeries = (event: FormEvent) => {
    event.preventDefault();
    if (!seriesTitle.trim()) return;
    createSeries({ title: seriesTitle, description: seriesDescription, styleRules: seriesStyle });
    setSeriesTitle("");
    setSeriesDescription("");
    setSeriesStyle("");
    setSeriesDialogOpen(false);
  };

  const submitCharacter = (event: FormEvent) => {
    event.preventDefault();
    if (!activeSeries || !characterName.trim()) return;
    createCharacter({
      seriesId: activeSeries.id,
      name: characterName,
      role: characterRole,
      visualTraits: characterTraits,
      canonicalRules: characterRules,
      outfits: characterOutfits.split(","),
    });
    setCharacterName("");
    setCharacterRole("");
    setCharacterTraits("");
    setCharacterRules("");
    setCharacterOutfits("");
    setCharacterDialogOpen(false);
  };

  const submitAsset = (event: FormEvent) => {
    event.preventDefault();
    if (!assetCharacterId || !assetSource.trim()) return;
    addReferenceAsset({
      characterId: assetCharacterId,
      name: assetName,
      source: assetSource,
      status: "draft",
    });
    setAssetName("");
    setAssetSource("");
    setAssetCharacterId(null);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full items-center gap-3">
            <div className="flex min-w-0 items-center gap-2 font-medium">
              <FilmIcon className="size-4" />
              <span>Series Board</span>
              {activeSeries ? (
                <span className="truncate text-muted-foreground">/ {activeSeries.title}</span>
              ) : null}
            </div>
            <Button
              className="ml-auto"
              size="sm"
              variant="outline"
              onClick={() => setSeriesDialogOpen(true)}
            >
              <PlusIcon className="size-4" /> New series
            </Button>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="space-y-6 py-6">
            {series.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {series.map((entry) => (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant={entry.id === activeSeries?.id ? "default" : "outline"}
                    onClick={() => setActiveSeries(entry.id)}
                  >
                    {entry.title}
                  </Button>
                ))}
              </div>
            ) : null}

            {!activeSeries ? (
              <section className="flex min-h-[55vh] flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/15 p-10 text-center">
                <FilmIcon className="mb-4 size-10 text-muted-foreground" />
                <h1 className="text-2xl font-semibold">Create your first ShiryuGen series</h1>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                  A series holds your character kits, canon references, style rules, scenes, and
                  later video shots.
                </p>
                <Button className="mt-6" onClick={() => setSeriesDialogOpen(true)}>
                  <PlusIcon className="size-4" /> Create series
                </Button>
              </section>
            ) : (
              <>
                <section className="rounded-2xl border border-border/70 bg-card/40 p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="max-w-3xl">
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                        Production project
                      </p>
                      <h1 className="mt-1 text-3xl font-semibold">{activeSeries.title}</h1>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {activeSeries.description || "No series description yet."}
                      </p>
                      {activeSeries.styleRules ? (
                        <p className="mt-3 text-sm">
                          <span className="font-medium">Style:</span> {activeSeries.styleRules}
                        </p>
                      ) : null}
                    </div>
                    <Button onClick={() => setCharacterDialogOpen(true)}>
                      <PlusIcon className="size-4" /> Add character kit
                    </Button>
                  </div>
                  <div className="mt-6 grid gap-3 sm:grid-cols-3">
                    <Stat
                      icon={<UsersRoundIcon className="size-4" />}
                      label="Characters"
                      value={activeCharacters.length}
                    />
                    <Stat
                      icon={<ShieldCheckIcon className="size-4" />}
                      label="Canon references"
                      value={canonCount}
                    />
                    <Stat
                      icon={<ImageIcon className="size-4" />}
                      label="All references"
                      value={referenceCount}
                    />
                  </div>
                </section>

                <CharacterGenerationPanel
                  series={activeSeries}
                  characters={activeCharacters}
                  selectedCharacterId={effectiveGenerationCharacterId}
                  onSelectedCharacterIdChange={setSelectedGenerationCharacterId}
                />

                <section>
                  <div className="mb-3 flex items-end justify-between gap-4">
                    <div>
                      <h2 className="text-lg font-semibold">Character continuity</h2>
                      <p className="text-sm text-muted-foreground">
                        Compare each character against approved and canon reference images.
                      </p>
                    </div>
                  </div>
                  {activeCharacters.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/70 p-10 text-center text-sm text-muted-foreground">
                      No character kits yet.
                    </div>
                  ) : (
                    <div className="grid gap-4 xl:grid-cols-3 2xl:grid-cols-4">
                      {activeCharacters.map((character) => {
                        const cover = selectCharacterCoverAsset(character);
                        return (
                          <article
                            key={character.id}
                            className="overflow-hidden rounded-xl border border-border/70 bg-card/40"
                          >
                            <div className="aspect-[4/3] bg-muted/30">
                              {cover ? (
                                <ReferenceAssetPreview
                                  asset={cover}
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full items-center justify-center text-muted-foreground">
                                  <ImageIcon className="size-8" />
                                </div>
                              )}
                            </div>
                            <div className="space-y-3 p-4">
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <h3 className="truncate font-semibold">{character.name}</h3>
                                  <p className="truncate text-xs text-muted-foreground">
                                    {character.role || "Character"}
                                  </p>
                                </div>
                                <Button
                                  size="icon-xs"
                                  variant="ghost"
                                  aria-label={`Delete ${character.name}`}
                                  onClick={() => removeCharacter(character.id)}
                                >
                                  <Trash2Icon className="size-3.5" />
                                </Button>
                              </div>
                              {character.visualTraits ? (
                                <p className="line-clamp-3 text-xs text-muted-foreground">
                                  {character.visualTraits}
                                </p>
                              ) : null}
                              {character.outfits.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {character.outfits.map((outfit) => (
                                    <span
                                      key={outfit}
                                      className="rounded-full border border-border/70 px-2 py-0.5 text-[10px]"
                                    >
                                      {outfit}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              <div className="space-y-2">
                                {character.referenceAssets.map((asset) => (
                                  <div
                                    key={asset.id}
                                    className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-xs"
                                  >
                                    <ReferenceAssetPreview
                                      asset={asset}
                                      className="size-8 shrink-0 rounded object-cover"
                                    />
                                    <span className="min-w-0 flex-1 truncate">{asset.name}</span>
                                    <select
                                      className="rounded border border-border bg-background px-1 py-0.5 text-[10px]"
                                      value={asset.status}
                                      onChange={(event) =>
                                        setReferenceAssetStatus(
                                          character.id,
                                          asset.id,
                                          event.target.value as ShiryuGenAssetStatus,
                                        )
                                      }
                                    >
                                      {assetStatuses.map((status) => (
                                        <option key={status} value={status}>
                                          {status}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                ))}
                              </div>
                              <div className="grid grid-cols-2 gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => setAssetCharacterId(character.id)}
                                >
                                  <PlusIcon className="size-3.5" /> Add reference
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => selectCharacterForGeneration(character.id)}
                                >
                                  <FilmIcon className="size-3.5" /> Generate
                                </Button>
                                <Button
                                  className="col-span-2"
                                  size="sm"
                                  variant="ghost"
                                  disabled={
                                    character.referenceAssets.filter(
                                      (asset) =>
                                        asset.status === "canon" || asset.status === "approved",
                                    ).length < 2
                                  }
                                  onClick={() => setCompareCharacterId(character.id)}
                                >
                                  <Columns2Icon className="size-3.5" /> Compare references
                                </Button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="rounded-xl border border-border/70 bg-muted/10 p-5">
                  <h2 className="font-semibold">Video pipeline</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Scenes, shots, image-to-video, and final clip assembly will build on these same
                    character kits so approved canon references stay attached throughout production.
                  </p>
                </section>
              </>
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>

      <Dialog open={seriesDialogOpen} onOpenChange={setSeriesDialogOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>New series</DialogTitle>
            <DialogDescription>
              Create a production project for characters, scenes, and videos.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id="new-series" className="space-y-4" onSubmit={submitSeries}>
              <Field label="Title">
                <Input
                  autoFocus
                  value={seriesTitle}
                  onChange={(e) => setSeriesTitle(e.target.value)}
                  placeholder="Asteria"
                />
              </Field>
              <Field label="Description">
                <Textarea
                  value={seriesDescription}
                  onChange={(e) => setSeriesDescription(e.target.value)}
                />
              </Field>
              <Field label="Visual style rules">
                <Textarea
                  value={seriesStyle}
                  onChange={(e) => setSeriesStyle(e.target.value)}
                  placeholder="Cinematic anime, warm highlights, consistent proportions..."
                />
              </Field>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeriesDialogOpen(false)}>
              Cancel
            </Button>
            <Button form="new-series" type="submit">
              Create series
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={characterDialogOpen} onOpenChange={setCharacterDialogOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New character kit</DialogTitle>
            <DialogDescription>
              Lock identity details now so future image and video workflows can reuse them.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id="new-character" className="space-y-4" onSubmit={submitCharacter}>
              <Field label="Name">
                <Input
                  autoFocus
                  value={characterName}
                  onChange={(e) => setCharacterName(e.target.value)}
                />
              </Field>
              <Field label="Role">
                <Input
                  value={characterRole}
                  onChange={(e) => setCharacterRole(e.target.value)}
                  placeholder="Main heroine"
                />
              </Field>
              <Field label="Visual traits">
                <Textarea
                  value={characterTraits}
                  onChange={(e) => setCharacterTraits(e.target.value)}
                  placeholder="Hair, eyes, build, species traits..."
                />
              </Field>
              <Field label="Canon rules">
                <Textarea
                  value={characterRules}
                  onChange={(e) => setCharacterRules(e.target.value)}
                  placeholder="Traits that must never drift between generations..."
                />
              </Field>
              <Field label="Outfits / forms (comma separated)">
                <Input
                  value={characterOutfits}
                  onChange={(e) => setCharacterOutfits(e.target.value)}
                  placeholder="Academy uniform, combat form"
                />
              </Field>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCharacterDialogOpen(false)}>
              Cancel
            </Button>
            <Button form="new-character" type="submit">
              Create kit
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={assetCharacterId !== null}
        onOpenChange={(open) => {
          if (!open) setAssetCharacterId(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add reference asset</DialogTitle>
            <DialogDescription>
              Add an external image URL or previewable source manually. Generated ShiryuGen images
              can now be attached directly from their chat toolbar.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form id="new-reference" className="space-y-4" onSubmit={submitAsset}>
              <Field label="Name">
                <Input
                  value={assetName}
                  onChange={(e) => setAssetName(e.target.value)}
                  placeholder="Front portrait"
                />
              </Field>
              <Field label="Image source">
                <Input
                  autoFocus
                  value={assetSource}
                  onChange={(e) => setAssetSource(e.target.value)}
                  placeholder="https://... or /local-preview/..."
                />
              </Field>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssetCharacterId(null)}>
              Cancel
            </Button>
            <Button form="new-reference" type="submit">
              Add reference
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={compareCharacter !== null}
        onOpenChange={(open) => {
          if (!open) setCompareCharacterId(null);
        }}
      >
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>Compare {compareCharacter?.name ?? "character"} references</DialogTitle>
            <DialogDescription>
              Review Canon and Approved images side by side before choosing the primary generation
              reference.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {compareReferences.map((asset) => (
                <div
                  key={asset.id}
                  className="overflow-hidden rounded-xl border border-border/70 bg-muted/15"
                >
                  <div className="aspect-[4/5] bg-muted/30">
                    <ReferenceAssetPreview asset={asset} className="h-full w-full object-contain" />
                  </div>
                  <div className="p-3">
                    <div className="truncate text-sm font-medium">{asset.name}</div>
                    <div className="mt-1 text-[10px] font-medium uppercase tracking-[0.15em] text-muted-foreground">
                      {asset.status}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button onClick={() => setCompareCharacterId(null)}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}

function Stat(props: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/50 p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {props.icon}
        {props.label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</div>
    </div>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{props.label}</Label>
      {props.children}
    </div>
  );
}
