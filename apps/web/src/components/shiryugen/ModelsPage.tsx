import {
  ProviderInstanceId,
  type ShiryuGenCivitaiInstallTask,
  type ShiryuGenCivitaiModelSummary,
  type ShiryuGenComfyUiStatus,
  type ShiryuGenInstalledModel,
} from "@t3tools/contracts";
import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  KeyRoundIcon,
  LibraryIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { isElectron } from "../../env";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { readComfyUiStatus } from "../../shiryuGenComfyUi";
import {
  queueCivitaiModelInstall,
  readCivitaiConfig,
  readCivitaiModelInstallTasks,
  readInstalledCivitaiModels,
  searchCivitaiModels,
  uninstallCivitaiModel,
  updateCivitaiApiKey,
} from "../../shiryuGenCivitai";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { OmniRouteIcon } from "../Icons";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";

const MODEL_TYPES = [
  { value: "all", label: "All model types" },
  { value: "Checkpoint", label: "Checkpoints" },
  { value: "LORA", label: "LoRAs" },
  { value: "Controlnet", label: "ControlNet" },
  { value: "TextualInversion", label: "Embeddings" },
] as const;

const SORT_OPTIONS = [
  { value: "Most Downloaded", label: "Most downloaded" },
  { value: "Highest Rated", label: "Highest rated" },
  { value: "Newest", label: "Newest" },
] as const;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return "ShiryuGen could not complete the CivitAI request.";
}

function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function resolveInstalledAbsolutePath(root: string, relativePath: string): string {
  const windowsStyle = root.includes("\\") && !root.includes("/");
  const separator = windowsStyle ? "\\" : "/";
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const normalizedRelative = relativePath.replace(/[\\/]+/g, separator).replace(/^[\\/]+/, "");
  return `${normalizedRoot}${separator}${normalizedRelative}`;
}

function readObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function formatFileSize(value: number): string {
  if (value <= 0) return "Unknown size";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 1 : 2)} ${units[index]}`;
}

export function isActiveCivitaiInstallTask(task: ShiryuGenCivitaiInstallTask | null): boolean {
  return (
    task !== null &&
    (task.status === "queued" ||
      task.status === "downloading" ||
      task.status === "verifying" ||
      task.status === "installing")
  );
}

export function civitaiInstallTaskLabel(task: ShiryuGenCivitaiInstallTask): string {
  if (task.status === "queued") return "Queued";
  if (task.status === "downloading") {
    return task.progress === null ? "Downloading…" : `Downloading ${Math.round(task.progress)}%`;
  }
  if (task.status === "verifying") return "Verifying";
  if (task.status === "installing") return "Installing";
  if (task.status === "completed") return "Installed";
  if (task.status === "failed") return "Failed";
  return "Cancelled";
}

export function mergeCompletedCivitaiInstall(
  current: ShiryuGenInstalledModel[],
  task: ShiryuGenCivitaiInstallTask,
): ShiryuGenInstalledModel[] {
  if (task.status !== "completed" || task.installed === null) return current;
  return [...current.filter((entry) => entry.modelId !== task.modelId), task.installed];
}

export function ModelsPage() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [comfyStatus, setComfyStatus] = useState<ShiryuGenComfyUiStatus | null>(null);
  const [checkingComfy, setCheckingComfy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [baseModel, setBaseModel] = useState("");
  const [sort, setSort] = useState("Most Downloaded");
  const [models, setModels] = useState<ShiryuGenCivitaiModelSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [installedModels, setInstalledModels] = useState<ShiryuGenInstalledModel[]>([]);
  const [installTasks, setInstallTasks] = useState<ShiryuGenCivitaiInstallTask[]>([]);
  const [downloadSummary, setDownloadSummary] = useState({
    activeCount: 0,
    queuedCount: 0,
    maxConcurrency: settings.imageGeneration.modelDownloadConcurrency,
  });
  const [removingModelIds, setRemovingModelIds] = useState<ReadonlySet<number>>(new Set());
  const handledTerminalTaskIds = useRef<Set<string>>(new Set());
  const installTaskPollingInitialized = useRef(false);
  const omniRouteConfig = readObject(
    settings.providerInstances[ProviderInstanceId.make("omniroute")]?.config,
  );
  const omniRouteEndpoint =
    typeof omniRouteConfig?.endpoint === "string" && omniRouteConfig.endpoint.trim()
      ? omniRouteConfig.endpoint.trim()
      : "http://127.0.0.1:20128";
  const omniRouteFreeOnly =
    typeof omniRouteConfig?.freeOnly === "boolean" ? omniRouteConfig.freeOnly : true;

  const refreshInstalledModels = useCallback(async () => {
    try {
      const result = await readInstalledCivitaiModels();
      setInstalledModels([...result.items]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not read installed models",
        description: errorMessage(error),
      });
    }
  }, []);

  const refreshInstallTasks = useCallback(async () => {
    try {
      const result = await readCivitaiModelInstallTasks();
      if (!installTaskPollingInitialized.current) {
        for (const task of result.tasks) {
          if (
            task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled"
          ) {
            handledTerminalTaskIds.current.add(task.id);
          }
        }
        installTaskPollingInitialized.current = true;
      }
      setInstallTasks([...result.tasks]);
      setDownloadSummary({
        activeCount: result.activeCount,
        queuedCount: result.queuedCount,
        maxConcurrency: result.maxConcurrency,
      });
    } catch {
      // The model browser remains usable if a transient task-status poll fails.
    }
  }, []);

  const refreshComfyStatus = useCallback(async () => {
    setCheckingComfy(true);
    try {
      setComfyStatus(await readComfyUiStatus());
    } catch (error) {
      setComfyStatus({
        endpoint: "",
        reachable: false,
        nodeCount: 0,
        deviceName: null,
        error: errorMessage(error),
        runtimeState: "failed",
        managedByShiryuGen: false,
      });
    } finally {
      setCheckingComfy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void readCivitaiConfig()
      .then((status) => {
        if (active) setConfigured(status.configured);
      })
      .catch(() => {
        if (active) setConfigured(false);
      });
    void refreshComfyStatus();
    void refreshInstalledModels();
    void refreshInstallTasks();
    const taskPoll = window.setInterval(() => void refreshInstallTasks(), 750);
    return () => {
      active = false;
      window.clearInterval(taskPoll);
    };
  }, [refreshComfyStatus, refreshInstallTasks, refreshInstalledModels]);

  useEffect(() => {
    if (comfyStatus?.runtimeState !== "starting") return;
    const statusPoll = window.setInterval(() => void refreshComfyStatus(), 1_000);
    return () => window.clearInterval(statusPoll);
  }, [comfyStatus?.runtimeState, refreshComfyStatus]);

  const runSearch = useCallback(
    async (cursor = "", append = false) => {
      if (append) setLoadingMore(true);
      else setSearching(true);
      setSearchError(null);
      try {
        const result = await searchCivitaiModels({
          query: query.trim(),
          type: type === "all" ? "" : type,
          baseModel: baseModel.trim(),
          sort,
          limit: 24,
          cursor,
        });
        setModels((previous) => (append ? [...previous, ...result.items] : [...result.items]));
        setNextCursor(result.nextCursor);
      } catch (error) {
        setSearchError(errorMessage(error));
      } finally {
        setSearching(false);
        setLoadingMore(false);
      }
    },
    [baseModel, query, sort, type],
  );

  useEffect(() => {
    void runSearch();
  }, []); // Initial discovery only. Filters run explicitly so typing never floods CivitAI.

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    void runSearch();
  };

  const saveApiKey = async () => {
    const normalized = apiKey.trim();
    if (!normalized || savingKey) return;
    setSavingKey(true);
    try {
      const status = await updateCivitaiApiKey(normalized);
      setConfigured(status.configured);
      setApiKey("");
      toastManager.add({
        type: "success",
        title: "CivitAI connected",
        description:
          "The API key is stored on the ShiryuGen host and is not exposed back to clients.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save CivitAI key",
        description: errorMessage(error),
      });
    } finally {
      setSavingKey(false);
    }
  };

  const removeApiKey = async () => {
    if (savingKey) return;
    setSavingKey(true);
    try {
      const status = await updateCivitaiApiKey("");
      setConfigured(status.configured);
      setApiKey("");
      toastManager.add({
        type: "success",
        title: "CivitAI key removed",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not remove CivitAI key",
        description: errorMessage(error),
      });
    } finally {
      setSavingKey(false);
    }
  };

  const installedByModelId = useMemo(
    () => new Map(installedModels.map((model) => [model.modelId, model] as const)),
    [installedModels],
  );
  const latestTaskByModelId = useMemo(() => {
    const latest = new Map<number, ShiryuGenCivitaiInstallTask>();
    for (const task of installTasks) latest.set(task.modelId, task);
    return latest;
  }, [installTasks]);

  useEffect(() => {
    for (const task of installTasks) {
      if (task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled") {
        continue;
      }
      if (handledTerminalTaskIds.current.has(task.id)) continue;
      handledTerminalTaskIds.current.add(task.id);

      if (task.status === "completed" && task.installed) {
        const previous = installedByModelId.get(task.modelId) ?? null;
        setInstalledModels((current) => mergeCompletedCivitaiInstall(current, task));

        if (previous) {
          const previousPath = resolveInstalledAbsolutePath(
            settings.imageGeneration.comfyUiRootDirectory,
            previous.relativePath,
          );
          const nextPath = resolveInstalledAbsolutePath(
            settings.imageGeneration.comfyUiRootDirectory,
            task.installed.relativePath,
          );
          const activeCheckpointMoved =
            settings.imageGeneration.customCheckpointPath === previousPath;
          const loraPathMoved = settings.imageGeneration.loras.some(
            (lora) => lora.path === previousPath,
          );
          if (activeCheckpointMoved || loraPathMoved) {
            updateSettings({
              imageGeneration: {
                ...(activeCheckpointMoved ? { customCheckpointPath: nextPath } : {}),
                ...(loraPathMoved
                  ? {
                      loras: settings.imageGeneration.loras.map((lora) =>
                        lora.path === previousPath
                          ? { ...lora, path: nextPath, name: task.installed!.modelName }
                          : lora,
                      ),
                    }
                  : {}),
              },
            });
          }
        }

        toastManager.add({
          type: "success",
          title: task.replacedVersionId === null ? "Model installed" : "Model updated",
          description: `${task.installed.modelName} is available in ComfyUI/${task.installed.installTarget}.`,
        });
        void refreshComfyStatus();
      } else if (task.status === "failed") {
        toastManager.add({
          type: "error",
          title: "Model installation failed",
          description: task.error ?? "The CivitAI model download failed.",
        });
      }
    }
  }, [
    installTasks,
    installedByModelId,
    refreshComfyStatus,
    settings.imageGeneration,
    updateSettings,
  ]);

  const handleInstallModel = async (model: ShiryuGenCivitaiModelSummary) => {
    if (model.versionId === null) return;
    const existingTask = latestTaskByModelId.get(model.id) ?? null;
    if (isActiveCivitaiInstallTask(existingTask)) return;
    try {
      const task = await queueCivitaiModelInstall(model.id, model.versionId);
      setInstallTasks((current) => [...current.filter((entry) => entry.id !== task.id), task]);
      void refreshInstallTasks();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start model installation",
        description: errorMessage(error),
      });
    }
  };

  const handleUseInstalled = (installed: ShiryuGenInstalledModel) => {
    const absolutePath = resolveInstalledAbsolutePath(
      settings.imageGeneration.comfyUiRootDirectory,
      installed.relativePath,
    );
    if (installed.installTarget === "checkpoints") {
      updateSettings({
        imageGeneration: {
          checkpoint: "custom",
          customCheckpointPath: absolutePath,
        },
      });
      toastManager.add({
        type: "success",
        title: "Checkpoint selected",
        description: `${installed.modelName} is now the active ShiryuGen checkpoint.`,
      });
      return;
    }
    if (installed.installTarget === "loras") {
      const existing = settings.imageGeneration.loras.find((lora) => lora.path === absolutePath);
      const nextLoras = existing
        ? settings.imageGeneration.loras.map((lora) =>
            lora.path === absolutePath ? { ...lora, enabled: true } : lora,
          )
        : [
            ...settings.imageGeneration.loras,
            {
              id: `civitai-${installed.modelId}-${installed.versionId}`,
              name: installed.modelName,
              path: absolutePath,
              weight: 0.8,
              enabled: true,
            },
          ];
      updateSettings({ imageGeneration: { loras: nextLoras } });
      toastManager.add({
        type: "success",
        title: existing ? "LoRA enabled" : "LoRA added",
        description: `${installed.modelName} is enabled for ShiryuGen image workflows.`,
      });
    }
  };

  const handleRemoveModel = async (modelId: number) => {
    const installTask = latestTaskByModelId.get(modelId) ?? null;
    if (isActiveCivitaiInstallTask(installTask) || removingModelIds.has(modelId)) return;
    const installed = installedByModelId.get(modelId) ?? null;
    setRemovingModelIds((current) => new Set(current).add(modelId));
    try {
      const result = await uninstallCivitaiModel(modelId);
      if (result.removed) {
        setInstalledModels((current) => current.filter((entry) => entry.modelId !== modelId));
        if (installed) {
          const absolutePath = resolveInstalledAbsolutePath(
            settings.imageGeneration.comfyUiRootDirectory,
            installed.relativePath,
          );
          const wasActiveCheckpoint =
            settings.imageGeneration.customCheckpointPath === absolutePath;
          const nextLoras = settings.imageGeneration.loras.filter(
            (lora) => lora.path !== absolutePath,
          );
          updateSettings({
            imageGeneration: {
              ...(wasActiveCheckpoint ? { checkpoint: "auto", customCheckpointPath: "" } : {}),
              ...(nextLoras.length !== settings.imageGeneration.loras.length
                ? { loras: nextLoras }
                : {}),
            },
          });
        }
        toastManager.add({ type: "success", title: "Model removed" });
        void refreshComfyStatus();
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not remove model",
        description: errorMessage(error),
      });
    } finally {
      setRemovingModelIds((current) => {
        const next = new Set(current);
        next.delete(modelId);
        return next;
      });
    }
  };

  const resultSummary = useMemo(() => {
    if (searching) return "Searching CivitAI…";
    if (models.length === 0) return "No models loaded";
    return `${models.length} model${models.length === 1 ? "" : "s"} loaded`;
  }, [models.length, searching]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron}>
          <div className="flex w-full min-w-0 items-center gap-3">
            <LibraryIcon className="size-4 shrink-0" />
            <div className="min-w-0 font-medium">Models</div>
            <div className="truncate text-sm text-muted-foreground">Routing & generation</div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide" className="space-y-6 py-6">
            <section className="rounded-2xl border border-border/70 bg-card/40 p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-3xl">
                  <div className="flex items-center gap-2">
                    <OmniRouteIcon className="size-5" />
                    <h1 className="text-xl font-semibold">OmniRoute</h1>
                    <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium">
                      {omniRouteFreeOnly ? "Free only" : "All routes"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    ShiryuGen uses OmniRoute as the primary cloud-model gateway. OpenRouter and
                    other upstream providers stay behind one routing layer, while Ollama remains
                    available as a direct local option.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="rounded-md border border-border/60 bg-background/40 px-2 py-1 font-mono">
                      {omniRouteEndpoint}
                    </span>
                    <span className="rounded-md border border-border/60 bg-background/40 px-2 py-1">
                      Coding: auto/coding:free
                    </span>
                    <span className="rounded-md border border-border/60 bg-background/40 px-2 py-1">
                      Chat: auto/chat:free
                    </span>
                    <span className="rounded-md border border-border/60 bg-background/40 px-2 py-1">
                      Reasoning: auto/reasoning:free
                    </span>
                  </div>
                </div>
                <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">
                  Provider credentials and endpoint access live in Settings → Providers. This page
                  stays focused on choosing models and generation assets.
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border/70 bg-card/40 p-5">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
                <div className="max-w-2xl">
                  <div className="flex items-center gap-2">
                    <h1 className="text-xl font-semibold">Headless ComfyUI</h1>
                    {comfyStatus?.reachable ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium">
                        <CheckCircle2Icon className="size-3.5" /> Ready
                      </span>
                    ) : (
                      <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
                        {comfyStatus?.runtimeState === "starting"
                          ? "Starting…"
                          : comfyStatus?.runtimeState === "failed"
                            ? "Failed to start"
                            : checkingComfy
                              ? "Checking…"
                              : "Offline"}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    ShiryuGen talks directly to ComfyUI&apos;s API. The ComfyUI browser interface is
                    not part of the ShiryuGen workflow.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    {comfyStatus?.endpoint ? <span>{comfyStatus.endpoint}</span> : null}
                    {comfyStatus?.reachable ? (
                      <span>{comfyStatus.nodeCount} nodes available</span>
                    ) : null}
                    {comfyStatus?.managedByShiryuGen ? <span>Managed by ShiryuGen</span> : null}
                    {comfyStatus?.deviceName ? <span>{comfyStatus.deviceName}</span> : null}
                    {!comfyStatus?.reachable && comfyStatus?.error ? (
                      <span>{comfyStatus.error}</span>
                    ) : null}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checkingComfy}
                  onClick={() => void refreshComfyStatus()}
                >
                  <RefreshCwIcon className="size-3.5" />
                  {checkingComfy ? "Checking…" : "Check engine"}
                </Button>
              </div>

              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="max-w-2xl">
                  <div className="flex items-center gap-2">
                    <h1 className="text-xl font-semibold">CivitAI</h1>
                    {configured === true ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 py-1 text-[11px] font-medium">
                        <CheckCircle2Icon className="size-3.5" /> Connected
                      </span>
                    ) : configured === false ? (
                      <span className="rounded-full border border-border/70 px-2 py-1 text-[11px] text-muted-foreground">
                        Public browsing
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Browse image and video-generation models from inside ShiryuGen. The API key is
                    stored only on the host; the UI receives connection status, never the saved key.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheckIcon className="size-4" /> Host-side credential storage
                </div>
              </div>

              <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
                <div className="space-y-1.5">
                  <Label htmlFor="civitai-api-key">CivitAI API key</Label>
                  <div className="relative">
                    <KeyRoundIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="civitai-api-key"
                      type="password"
                      autoComplete="off"
                      className="pl-9"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.currentTarget.value)}
                      placeholder={
                        configured
                          ? "Stored secret — enter a new key to replace it"
                          : "Paste a CivitAI API key"
                      }
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  {configured ? (
                    <Button
                      variant="outline"
                      disabled={savingKey}
                      onClick={() => void removeApiKey()}
                    >
                      Remove key
                    </Button>
                  ) : null}
                  <Button disabled={!apiKey.trim() || savingKey} onClick={() => void saveApiKey()}>
                    {savingKey ? "Saving…" : configured ? "Replace key" : "Connect"}
                  </Button>
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <div>
                <h2 className="text-lg font-semibold">Model browser</h2>
                <p className="text-sm text-muted-foreground">
                  Search checkpoints, LoRAs, ControlNet models, and architectures that can later be
                  installed into ShiryuGen&apos;s headless generation engine.
                </p>
              </div>

              <form
                className="grid gap-2 rounded-xl border border-border/70 bg-card/30 p-3 md:grid-cols-[minmax(14rem,1fr)_12rem_minmax(10rem,14rem)_12rem_auto]"
                onSubmit={submitSearch}
              >
                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    className="pl-9"
                    placeholder="Search CivitAI models"
                    aria-label="Search CivitAI models"
                  />
                </div>
                <Select value={type} onValueChange={(value) => setType(value ?? "all")}>
                  <SelectTrigger aria-label="Model type">
                    <SelectValue>
                      {MODEL_TYPES.find((entry) => entry.value === type)?.label ??
                        "All model types"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {MODEL_TYPES.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Input
                  value={baseModel}
                  onChange={(event) => setBaseModel(event.currentTarget.value)}
                  placeholder="Base model, e.g. Flux"
                  aria-label="Base model filter"
                />
                <Select value={sort} onValueChange={(value) => value && setSort(value)}>
                  <SelectTrigger aria-label="CivitAI sort">
                    <SelectValue>
                      {SORT_OPTIONS.find((entry) => entry.value === sort)?.label ??
                        "Most downloaded"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {SORT_OPTIONS.map((entry) => (
                      <SelectItem key={entry.value} value={entry.value}>
                        {entry.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Button type="submit" disabled={searching}>
                  {searching ? "Searching…" : "Search"}
                </Button>
              </form>

              <CivitaiDownloadQueueSummary
                activeCount={downloadSummary.activeCount}
                queuedCount={downloadSummary.queuedCount}
                maxConcurrency={downloadSummary.maxConcurrency}
              />

              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{resultSummary}</span>
                <span>{installedModels.length} installed through ShiryuGen</span>
              </div>

              {searchError ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
                  {searchError}
                </div>
              ) : null}

              {models.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {models.map((model) => (
                    <CivitaiModelCard
                      key={`${model.id}:${model.versionId ?? "none"}`}
                      model={model}
                      installed={installedByModelId.get(model.id) ?? null}
                      task={latestTaskByModelId.get(model.id) ?? null}
                      removing={removingModelIds.has(model.id)}
                      onInstall={handleInstallModel}
                      onRemove={handleRemoveModel}
                      onUse={handleUseInstalled}
                    />
                  ))}
                </div>
              ) : !searching && !searchError ? (
                <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-border/70 text-center text-muted-foreground">
                  <ImageIcon className="mb-3 size-8" />
                  <div className="text-sm font-medium text-foreground">No models found</div>
                  <div className="mt-1 text-xs">Try a broader search or clear a filter.</div>
                </div>
              ) : null}

              {nextCursor ? (
                <div className="flex justify-center py-2">
                  <Button
                    variant="outline"
                    disabled={loadingMore}
                    onClick={() => void runSearch(nextCursor, true)}
                  >
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              ) : null}
            </section>
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

export function CivitaiDownloadQueueSummary({
  activeCount,
  queuedCount,
  maxConcurrency,
}: {
  activeCount: number;
  queuedCount: number;
  maxConcurrency: number;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
      <span>
        Downloads: {activeCount} active, {queuedCount} queued
      </span>
      <span>Max parallel downloads: {maxConcurrency}</span>
    </div>
  );
}

export function CivitaiModelCard({
  model,
  installed,
  task,
  removing,
  onInstall,
  onRemove,
  onUse,
}: {
  model: ShiryuGenCivitaiModelSummary;
  installed: ShiryuGenInstalledModel | null;
  task: ShiryuGenCivitaiInstallTask | null;
  removing: boolean;
  onInstall: (model: ShiryuGenCivitaiModelSummary) => void;
  onRemove: (modelId: number) => void;
  onUse: (installed: ShiryuGenInstalledModel) => void;
}) {
  const triggerWords = model.trainedWords.slice(0, 3);
  const installedCurrent = installed !== null && installed.versionId === model.versionId;
  const updateAvailable =
    installed !== null && model.versionId !== null && installed.versionId !== model.versionId;
  const canInstall = model.installSupported && model.versionId !== null;
  const installActive = isActiveCivitaiInstallTask(task);
  const actionLabel =
    installActive && task
      ? civitaiInstallTaskLabel(task)
      : installedCurrent
        ? "Installed"
        : task?.status === "failed"
          ? "Retry"
          : updateAvailable
            ? "Update"
            : "Install";

  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/40">
      <div className="relative aspect-[4/3] overflow-hidden bg-muted/30">
        {model.previewImageUrl ? (
          <img
            src={model.previewImageUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-8" />
          </div>
        )}
        {installed ? (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full border border-white/20 bg-black/65 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm">
            <CheckCircle2Icon className="size-3" />
            {installedCurrent ? "Installed" : "Update available"}
          </span>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-start gap-2">
            <h3 className="min-w-0 flex-1 truncate font-semibold" title={model.name}>
              {model.name}
            </h3>
            <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[10px] text-muted-foreground">
              {model.type}
            </span>
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {model.creatorName ? `by ${model.creatorName}` : "Unknown creator"}
            {model.baseModel ? ` · ${model.baseModel}` : ""}
          </p>
          {model.versionName ? (
            <p className="mt-1 truncate text-[11px] text-muted-foreground/75">
              {model.versionName}
            </p>
          ) : null}
        </div>

        {triggerWords.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {triggerWords.map((word) => (
              <span
                key={word}
                className="max-w-full truncate rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[10px]"
                title={word}
              >
                {word}
              </span>
            ))}
          </div>
        ) : null}

        <div className="space-y-1 text-[11px] text-muted-foreground">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <DownloadIcon className="size-3" /> {compactNumber(model.downloadCount)}
            </span>
            {model.rating !== null ? <span>{model.rating.toFixed(1)} ★</span> : null}
            {model.favoriteCount > 0 ? (
              <span>{compactNumber(model.favoriteCount)} favorites</span>
            ) : null}
          </div>
          {model.primaryFileName ? (
            <div className="truncate" title={model.primaryFileName}>
              {model.primaryFileName} · {formatFileSize(model.primaryFileSizeBytes)}
            </div>
          ) : null}
          {model.installTarget ? <div>ComfyUI/models/{model.installTarget}</div> : null}
          {model.installTarget === "diffusion_models" ||
          model.installTarget === "animatediff_models" ? (
            <div className="font-medium text-foreground/80">
              Video-capable model · kept out of the SDXL image workflow until its video compiler is
              enabled
            </div>
          ) : null}
          {installed && updateAvailable ? <div>Installed: {installed.versionName}</div> : null}
          {task && task.status !== "completed" ? (
            <div
              className={
                task.status === "failed" ? "text-destructive" : "font-medium text-foreground/80"
              }
            >
              {civitaiInstallTaskLabel(task)}
              {task.status === "failed" && task.error ? ` · ${task.error}` : ""}
            </div>
          ) : null}
        </div>

        <div className="mt-auto grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant={installedCurrent ? "secondary" : "outline"}
            disabled={!canInstall || installActive || removing || installedCurrent}
            title={
              !model.installSupported
                ? "ShiryuGen does not yet have a safe ComfyUI folder mapping for this model type."
                : installedCurrent
                  ? "This CivitAI version is already installed."
                  : undefined
            }
            onClick={() => onInstall(model)}
          >
            {installActive ? <RefreshCwIcon className="size-3.5 animate-spin" /> : null}
            {actionLabel}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            render={
              <a href={`https://civitai.com/models/${model.id}`} target="_blank" rel="noreferrer" />
            }
          >
            <ExternalLinkIcon className="size-3.5" /> View
          </Button>
        </div>
        {installed ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={
                installActive ||
                removing ||
                (installed.installTarget !== "checkpoints" && installed.installTarget !== "loras")
              }
              title={
                installed.installTarget === "checkpoints"
                  ? "Use this checkpoint for ShiryuGen image generation."
                  : installed.installTarget === "loras"
                    ? "Add or enable this LoRA in ShiryuGen image generation."
                    : "This model is installed and will become selectable when its workflow compiler is enabled."
              }
              onClick={() => onUse(installed)}
            >
              {installed.installTarget === "loras" ? "Add LoRA" : "Use model"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive"
              disabled={installActive || removing}
              onClick={() => onRemove(model.id)}
            >
              <Trash2Icon className="size-3.5" />
              {removing ? "Removing…" : "Remove"}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}
