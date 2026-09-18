/**
 * Integrations settings - preferences for surfaces T3 Code embeds rather than
 * owns. Browser is the first section: the defaults a preview tab opens at,
 * applied to both hand-opened tabs and agent `preview_open` calls that don't
 * state their own size.
 *
 * @module IntegrationsSettings
 */
import {
  DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
  DEFAULT_BROWSER_VIEWPORT,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_VIEWPORT_MAX_AREA,
  PREVIEW_VIEWPORT_MAX_DIMENSION,
  PREVIEW_VIEWPORT_MIN_DIMENSION,
  PREVIEW_ZOOM_LEVELS,
  type PreviewAppearancePreference,
  type PreviewViewportSetting,
  type McpRegistryInstallOption,
  type McpRegistryServer,
  type McpServerConfig,
  type T3SkillConfig,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import {
  CheckCircle2Icon,
  Grid2X2Icon,
  ImageIcon,
  InfoIcon,
  KeyRoundIcon,
  ListIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  Trash2Icon,
  WifiIcon,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { authorizeMcpServerWithPopup } from "~/lib/mcpOAuth";
import {
  groupMcpRegistryServersByCategory,
  isMcpRegistryInstallConfigured,
  makeMcpRegistryServerConfig,
} from "~/mcpRegistry";
import { isElectron } from "../../env";
import { serverEnvironment } from "~/state/server";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { NumberField, NumberFieldGroup, NumberFieldInput } from "../ui/number-field";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  useClientSettings,
  usePrimarySettings,
  useUpdatePrimarySettings,
} from "~/hooks/useSettings";

import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ImageGenerationSettings } from "./ImageGenerationSettings";

const FILL_VALUE = "fill";
const RESPONSIVE_VALUE = "responsive";

/**
 * The size a "Responsive" default falls back to when the user switches away
 * from Fill and hasn't typed dimensions yet. Fill has no dimensions to carry
 * over, so the picker needs something concrete to seed the inputs with.
 */
const RESPONSIVE_SEED_SIZE = { width: 1280, height: 800 } as const;

const NO_GROUPING: Intl.NumberFormatOptions = { useGrouping: false };

const APPEARANCE_LABELS: Readonly<Record<PreviewAppearancePreference, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const zoomLabel = (zoomFactor: number) => `${Math.round(zoomFactor * 100)}%`;

const viewportSelectValue = (viewport: PreviewViewportSetting): string => {
  if (viewport._tag === "fill") return FILL_VALUE;
  if (
    viewport._tag === "preset" &&
    PREVIEW_VIEWPORT_PRESETS.some((preset) => preset.id === viewport.presetId)
  ) {
    return viewport.presetId;
  }
  return RESPONSIVE_VALUE;
};

/**
 * The trigger renders this rather than a bare `SelectValue`, which would fall
 * back to printing the raw stored value ("fill") because the options are built
 * inline instead of from an `items` map.
 */
const viewportSelectLabel = (viewport: PreviewViewportSetting): string => {
  const value = viewportSelectValue(viewport);
  if (value === FILL_VALUE) return "Fill panel";
  if (value === RESPONSIVE_VALUE) return "Responsive";
  return PREVIEW_VIEWPORT_PRESETS.find((preset) => preset.id === value)?.label ?? "Responsive";
};

const isValidDimension = (value: number) =>
  Number.isInteger(value) &&
  value >= PREVIEW_VIEWPORT_MIN_DIMENSION &&
  value <= PREVIEW_VIEWPORT_MAX_DIMENSION;

/**
 * A sized viewport with width and height swapped. Presets keep their identity
 * through a rotation — `resolvePreviewViewport` already stores rotated presets
 * as the preset id plus swapped dimensions — so a rotated iPad is still an
 * iPad, not an anonymous custom size.
 */
const rotateViewport = (
  viewport: Exclude<PreviewViewportSetting, { readonly _tag: "fill" }>,
): PreviewViewportSetting => ({
  ...viewport,
  width: viewport.height,
  height: viewport.width,
});

function BrowserViewportSetting({ disabled }: { readonly disabled: boolean }) {
  const viewport = useClientSettings((settings) => settings.browserDefaultViewport);
  const updateSettings = useUpdatePrimarySettings();

  const sized = viewport._tag === "fill" ? null : viewport;
  const presentedSize = {
    width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
    height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
  };

  const selectViewport = (value: string | null) => {
    if (value === FILL_VALUE) {
      updateSettings({ browserDefaultViewport: FILL_PREVIEW_VIEWPORT });
      return;
    }
    if (value === RESPONSIVE_VALUE) {
      updateSettings({
        browserDefaultViewport: {
          _tag: "freeform",
          width: sized?.width ?? RESPONSIVE_SEED_SIZE.width,
          height: sized?.height ?? RESPONSIVE_SEED_SIZE.height,
        },
      });
      return;
    }
    const preset = PREVIEW_VIEWPORT_PRESETS.find((candidate) => candidate.id === value);
    if (!preset) return;
    updateSettings({
      browserDefaultViewport: {
        _tag: "preset",
        width: preset.width,
        height: preset.height,
        presetId: preset.id,
      },
    });
  };

  // Committed on blur rather than per keystroke: typing "2560" passes through
  // "256", which is a legal dimension, so an onValueChange handler would
  // persist that intermediate size and churn the settings file on every key.
  const commitDimension = (axis: "width" | "height", value: number | null) => {
    if (value === null || !isValidDimension(value)) return;
    const next = { ...presentedSize, [axis]: value };
    if (next.width * next.height > PREVIEW_VIEWPORT_MAX_AREA) return;
    if (sized && next.width === sized.width && next.height === sized.height) return;
    // Typing a size means the preset no longer describes it.
    updateSettings({ browserDefaultViewport: { _tag: "freeform", ...next } });
  };

  return (
    <SettingsRow
      {...searchableSetting("browser-default-viewport")}
      description="The viewport a browser tab opens at, for both you and agents. Fill sizes the page to the panel; any other choice opens the device toolbar at that size."
      resetAction={
        !disabled && viewport._tag !== DEFAULT_BROWSER_VIEWPORT._tag ? (
          <SettingResetButton
            label="default browser viewport"
            onClick={() => updateSettings({ browserDefaultViewport: DEFAULT_BROWSER_VIEWPORT })}
          />
        ) : null
      }
      control={
        <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
          <Select
            value={viewportSelectValue(viewport)}
            onValueChange={selectViewport}
            disabled={disabled}
          >
            <SelectTrigger
              size="sm"
              className="w-full min-w-0 sm:w-44"
              aria-label="Default browser viewport"
            >
              <SelectValue>{viewportSelectLabel(viewport)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} className="min-w-64">
              <SelectItem value={FILL_VALUE}>Fill panel</SelectItem>
              <SelectItem value={RESPONSIVE_VALUE}>Responsive</SelectItem>
              <SelectGroup>
                <SelectGroupLabel>Standard</SelectGroupLabel>
                {PREVIEW_VIEWPORT_PRESETS.map((preset) => (
                  <SelectItem key={preset.id} value={preset.id}>
                    <span className="flex w-full items-center justify-between gap-5">
                      <span>{preset.label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {preset.detail}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>

          {sized ? (
            <div className="flex min-w-0 items-center gap-1">
              <NumberField
                value={presentedSize.width}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                // Pixel counts read as raw numbers; grouping would show "1,024".
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("width", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport width" />
                </NumberFieldGroup>
              </NumberField>
              <span className="text-xs text-muted-foreground">×</span>
              <NumberField
                value={presentedSize.height}
                min={PREVIEW_VIEWPORT_MIN_DIMENSION}
                max={PREVIEW_VIEWPORT_MAX_DIMENSION}
                disabled={disabled}
                format={NO_GROUPING}
                size="sm"
                className="w-20"
                onValueCommitted={(value) => commitDimension("height", value)}
              >
                <NumberFieldGroup>
                  <NumberFieldInput aria-label="Default viewport height" />
                </NumberFieldGroup>
              </NumberField>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost-muted"
                      disabled={disabled}
                      aria-label={`Rotate to ${
                        presentedSize.height >= presentedSize.width ? "landscape" : "portrait"
                      }`}
                      onClick={() =>
                        updateSettings({ browserDefaultViewport: rotateViewport(sized) })
                      }
                    >
                      <ScreenRotationIcon />
                    </Button>
                  }
                />
                <TooltipPopup side="top">Rotate</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function BrowserZoomSetting({ disabled }: { readonly disabled: boolean }) {
  const zoomFactor = useClientSettings((settings) => settings.browserDefaultZoomFactor);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-zoom")}
      description="Page zoom applied to new browser tabs."
      resetAction={
        !disabled && zoomFactor !== DEFAULT_PREVIEW_ZOOM_FACTOR ? (
          <SettingResetButton
            label="default browser zoom"
            onClick={() =>
              updateSettings({ browserDefaultZoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={String(zoomFactor)}
          onValueChange={(value) => {
            const next = PREVIEW_ZOOM_LEVELS.find((level) => String(level) === value);
            if (next !== undefined) updateSettings({ browserDefaultZoomFactor: next });
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser zoom">
            <SelectValue>{zoomLabel(zoomFactor)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {PREVIEW_ZOOM_LEVELS.map((level) => (
              <SelectItem hideIndicator key={level} value={String(level)}>
                {zoomLabel(level)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function BrowserAppearanceSetting({ disabled }: { readonly disabled: boolean }) {
  const appearance = useClientSettings((settings) => settings.browserDefaultAppearance);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-default-appearance")}
      description="The color scheme pages are told to prefer. System follows your OS setting."
      resetAction={
        !disabled && appearance !== DEFAULT_PREVIEW_APPEARANCE ? (
          <SettingResetButton
            label="default browser appearance"
            onClick={() => updateSettings({ browserDefaultAppearance: DEFAULT_PREVIEW_APPEARANCE })}
          />
        ) : null
      }
      control={
        <Select
          disabled={disabled}
          value={appearance}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") {
              updateSettings({ browserDefaultAppearance: value });
            }
          }}
        >
          <SelectTrigger className="w-full sm:w-40" aria-label="Default browser appearance">
            <SelectValue>{APPEARANCE_LABELS[appearance]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Object.entries(APPEARANCE_LABELS).map(([value, label]) => (
              <SelectItem hideIndicator key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function AgentBrowserAccessSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("agent-browser-access")}
      description="Let agents open and drive the preview browser. When off, T3 denies preview/browser actions while keeping always-available plugin and skill tools connected. Your own browser panel is unaffected."
      status={
        settings.enableAgentBrowserAccess
          ? undefined
          : "Applies to sessions started from now on; a running agent keeps the tools it was given."
      }
      resetAction={
        settings.enableAgentBrowserAccess !== DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess ? (
          <SettingResetButton
            label="agent browser access"
            onClick={() =>
              updateSettings({
                enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.enableAgentBrowserAccess}
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentBrowserAccess: Boolean(checked) })
          }
          aria-label="Allow agent browser access"
        />
      }
    />
  );
}

function BrowserAutoShowFloatingPreviewSetting({ disabled }: { readonly disabled: boolean }) {
  const autoShow = useClientSettings((settings) => settings.browserAutoShowFloatingPreview);
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsRow
      {...searchableSetting("browser-auto-show-floating-preview")}
      description="Pop the floating preview into view when an agent opens a browser. An agent that explicitly asks to show or hide its preview still gets what it asked for."
      resetAction={
        !disabled && autoShow !== DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW ? (
          <SettingResetButton
            label="auto-show floating preview"
            onClick={() =>
              updateSettings({
                browserAutoShowFloatingPreview: DEFAULT_BROWSER_AUTO_SHOW_FLOATING_PREVIEW,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          disabled={disabled}
          checked={autoShow}
          onCheckedChange={(checked) =>
            updateSettings({ browserAutoShowFloatingPreview: Boolean(checked) })
          }
          aria-label="Auto-show floating preview"
        />
      }
    />
  );
}

/**
 * Frames the client-local preview defaults as one unavailable block.
 *
 * Disabling each control on its own left the labels and descriptions at full
 * strength, so the group still read as editable. Boxing it puts the reason at
 * the top and dims everything it covers, which is also why the explanation
 * sits outside the dimmed area — the one part that must stay readable is the
 * part saying why the rest isn't.
 *
 * Disabled rather than hidden because these are *client* settings: editing
 * them from a browser tab would write preferences belonging to a different
 * client, reading as though the desktop app had been configured when it
 * hadn't.
 */
function DesktopOnlyBrowserDefaults({ children }: { readonly children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 py-1.5">
      <div className="flex items-start gap-2 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground sm:px-4">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <p>Only available in the desktop app.</p>
      </div>
      <div className="[&_h3]:opacity-64 [&_p]:opacity-64">{children}</div>
    </div>
  );
}

function BuiltInIntegrationsSetting() {
  const settings = usePrimarySettings();

  return (
    <SettingsRow
      id="built-in-integrations"
      title="Built-in integrations"
      description="T3-owned tools ship with the app and do not need a separate MCP server install."
    >
      <div className="grid gap-2 pb-3 pt-2 md:grid-cols-2">
        <div className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/15 p-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70">
            <ImageIcon className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Local Image Generation</span>
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                <CheckCircle2Icon className="size-3" /> Installed
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Local SDXL generation and img2img editing through <code>t3_generate_image</code>.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground/75">
              {settings.preferLocalImageGeneration
                ? "Preferred for image requests"
                : "Installed, but provider-native image routing is preferred"}
            </p>
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

function PluginCatalogIcon({ server }: { readonly server: McpRegistryServer }) {
  const [failed, setFailed] = useState(false);
  if (!server.iconUrl || failed) {
    return (
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70 text-muted-foreground">
        <ServerIcon className="size-5" />
      </div>
    );
  }

  return (
    <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-background/70 p-1.5">
      <img
        src={server.iconUrl}
        alt=""
        className="size-full object-contain"
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function McpPluginCatalogSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const searchRegistry = useAtomCommand(serverEnvironment.searchMcpRegistry, "MCP registry search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<McpRegistryServer>>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogView, setCatalogView] = useState<"grid" | "list">("grid");

  const search = useCallback(async () => {
    if (!primaryEnvironmentId) {
      setError("Connect to an environment before searching for plugins.");
      return;
    }

    setSearching(true);
    setError(null);
    try {
      const result = await searchRegistry({
        environmentId: primaryEnvironmentId,
        input: { query },
      });
      setSearched(true);
      if (result._tag === "Success") {
        setResults(result.value.servers);
      } else {
        setResults([]);
        setError("Could not search the official MCP Registry.");
      }
    } catch (cause) {
      setSearched(true);
      setResults([]);
      setError(
        cause instanceof Error ? cause.message : "Could not search the official MCP Registry.",
      );
    } finally {
      setSearching(false);
    }
  }, [primaryEnvironmentId, query, searchRegistry]);

  useEffect(() => {
    if (!primaryEnvironmentId || searched || searching) return;
    void search();
  }, [primaryEnvironmentId, search, searched, searching]);

  const install = (server: McpRegistryServer, option: McpRegistryInstallOption) => {
    if (isMcpRegistryInstallConfigured(settings.mcpServers, option)) return;
    const config = makeMcpRegistryServerConfig(server, option, settings.mcpServers);
    updateSettings({ mcpServers: [...settings.mcpServers, config] });
  };

  const groupedResults = groupMcpRegistryServersByCategory(results);

  return (
    <SettingsRow
      id="mcp-plugin-catalog"
      title="Plugin catalog"
      description="Search the official MCP Registry for apps and tool servers. Installed plugins become available to supported agents and direct model sessions when a new session starts."
    >
      <div className="space-y-3 pb-3 pt-2">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            aria-label="Search plugin catalog"
            value={query}
            placeholder="Search server names"
            disabled={searching}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !searching) {
                event.preventDefault();
                void search();
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={searching || !primaryEnvironmentId}
              onClick={() => void search()}
            >
              {searching ? <Loader2Icon className="animate-spin" /> : <SearchIcon />}
              {searching ? "Searching..." : "Search"}
            </Button>
            <div className="flex rounded-md border border-border/60 bg-muted/15 p-0.5">
              <Button
                size="icon-sm"
                variant={catalogView === "grid" ? "secondary" : "ghost-muted"}
                aria-label="Grid view"
                aria-pressed={catalogView === "grid"}
                onClick={() => setCatalogView("grid")}
              >
                <Grid2X2Icon />
              </Button>
              <Button
                size="icon-sm"
                variant={catalogView === "list" ? "secondary" : "ghost-muted"}
                aria-label="List view"
                aria-pressed={catalogView === "list"}
                onClick={() => setCatalogView("list")}
              >
                <ListIcon />
              </Button>
            </div>
          </div>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          Registry entries are third-party. Review them before installing; local npm plugins execute
          code on this environment.
        </p>
        {!primaryEnvironmentId ? (
          <p className="text-xs text-muted-foreground">
            Connect to an environment to search and install plugins.
          </p>
        ) : null}
        {error ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <InfoIcon className="size-3.5" /> {error}
          </p>
        ) : null}
        {searched && !searching && !error && results.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-5 text-center text-sm text-muted-foreground">
            No matching MCP servers were found.
          </div>
        ) : null}

        {groupedResults.map((group) => (
          <section key={group.category} className="space-y-2 pt-1">
            <div className="flex items-end justify-between gap-3 px-1">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold">{group.label}</h4>
                <p className="text-xs text-muted-foreground">{group.description}</p>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                {group.servers.length}
              </span>
            </div>

            <div
              className={
                catalogView === "grid" ? "grid gap-3 md:grid-cols-2 2xl:grid-cols-3" : "space-y-2"
              }
            >
              {group.servers.map((server) => (
                <div
                  key={`${server.name}@${server.version}`}
                  className="flex h-full flex-col rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4"
                >
                  <div
                    className={
                      catalogView === "grid"
                        ? "flex h-full flex-col gap-3"
                        : "flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
                    }
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <PluginCatalogIcon server={server} />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{server.title}</span>
                          <span className="text-xs text-muted-foreground">v{server.version}</span>
                        </div>
                        <p className="break-words text-sm text-muted-foreground">
                          {server.description}
                        </p>
                        <p className="break-all text-[11px] text-muted-foreground/80">
                          {server.name}
                        </p>
                      </div>
                    </div>
                    <div
                      className={
                        catalogView === "grid"
                          ? "mt-auto flex flex-wrap gap-2 pt-1"
                          : "flex shrink-0 flex-wrap gap-2"
                      }
                    >
                      {server.installs.map((option) => {
                        const configured = isMcpRegistryInstallConfigured(
                          settings.mcpServers,
                          option,
                        );
                        return (
                          <Button
                            key={option.id}
                            size="sm"
                            variant="outline"
                            disabled={configured}
                            onClick={() => install(server, option)}
                          >
                            {configured ? <CheckCircle2Icon /> : <PlusIcon />}
                            {configured
                              ? "Installed"
                              : option.requiresConfiguration
                                ? `Add & configure · ${option.label}`
                                : `Install · ${option.label}`}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                  {server.installs.length === 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      This registry entry needs setup that T3 Studio cannot install automatically
                      yet. Use the manual MCP server controls below.
                    </p>
                  ) : server.installs.some((option) => option.requiresConfiguration) ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      Some install options need credentials or configuration. Add the plugin, then
                      fill in its saved header or environment values below and test the connection.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </SettingsRow>
  );
}

function skillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function T3SkillsSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const skills = settings.t3Skills;

  const replaceSkill = (id: string, update: (skill: T3SkillConfig) => T3SkillConfig) =>
    updateSettings({
      t3Skills: skills.map((skill) => (skill.id === id ? update(skill) : skill)),
    });

  const addSkill = () => {
    let suffix = skills.length + 1;
    let name = `custom-skill-${suffix}`;
    while (skills.some((skill) => skill.name === name)) {
      suffix += 1;
      name = `custom-skill-${suffix}`;
    }
    const id = `t3-skill-${Date.now().toString(36)}-${suffix}`;
    updateSettings({
      t3Skills: [
        ...skills,
        {
          id,
          name,
          displayName: "New Skill",
          description: "Reusable workflow available to every T3 Studio provider.",
          instructions: "Describe the workflow this skill should follow.",
          enabled: true,
        },
      ],
    });
  };

  return (
    <SettingsRow
      id="t3-skills"
      title="T3 Skills"
      description="Create reusable workflow instructions once and use them with any provider. Type $ in the composer to activate an enabled skill for that turn."
      control={
        <Button size="sm" variant="outline" onClick={addSkill}>
          <PlusIcon /> Add skill
        </Button>
      }
    >
      <div className="space-y-3 pb-3 pt-2">
        {skills.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No T3 skills yet. Add one for workflows such as stream setup, release checks, order
            preparation, or project procedures.
          </div>
        ) : null}
        {skills.map((skill) => (
          <div key={skill.id} className="rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Skill display name"
                defaultValue={skill.displayName}
                className="font-medium"
                onBlur={(event) => {
                  const displayName = event.currentTarget.value.trim();
                  if (displayName && displayName !== skill.displayName) {
                    replaceSkill(skill.id, (value) => ({ ...value, displayName }));
                  }
                }}
              />
              <Switch
                checked={skill.enabled}
                onCheckedChange={(enabled) =>
                  replaceSkill(skill.id, (value) => ({ ...value, enabled: Boolean(enabled) }))
                }
                aria-label={`Enable ${skill.displayName}`}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove ${skill.displayName}`}
                onClick={() =>
                  updateSettings({ t3Skills: skills.filter((value) => value.id !== skill.id) })
                }
              >
                <Trash2Icon />
              </Button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Composer name
                </label>
                <Input
                  aria-label="Skill composer name"
                  defaultValue={skill.name}
                  onBlur={(event) => {
                    const base = skillSlug(event.currentTarget.value);
                    if (!base) return;
                    let name = base;
                    let suffix = 2;
                    while (
                      skills.some(
                        (candidate) =>
                          candidate.id !== skill.id &&
                          candidate.name.toLowerCase() === name.toLowerCase(),
                      )
                    ) {
                      name = `${base}-${suffix}`;
                      suffix += 1;
                    }
                    if (name !== skill.name) {
                      replaceSkill(skill.id, (value) => ({ ...value, name }));
                    }
                  }}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">Use as ${skill.name}</p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Description
                </label>
                <Input
                  aria-label="Skill description"
                  defaultValue={skill.description}
                  placeholder="What this workflow is for"
                  onBlur={(event) => {
                    const description = event.currentTarget.value.trim();
                    if (description !== skill.description) {
                      replaceSkill(skill.id, (value) => ({ ...value, description }));
                    }
                  }}
                />
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Workflow instructions
              </label>
              <Textarea
                aria-label="Skill workflow instructions"
                defaultValue={skill.instructions}
                rows={5}
                placeholder="Describe the steps, constraints, and plugins this workflow should use."
                onBlur={(event) => {
                  const instructions = event.currentTarget.value.trim();
                  if (instructions && instructions !== skill.instructions) {
                    replaceSkill(skill.id, (value) => ({ ...value, instructions }));
                  }
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </SettingsRow>
  );
}

function McpServersSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const checkMcpHealth = useAtomCommand(serverEnvironment.checkMcpHealth, "mcp health check");
  const servers = settings.mcpServers;
  const [authorizingServerId, setAuthorizingServerId] = useState<string | null>(null);
  const [authStatusByServerId, setAuthStatusByServerId] = useState<
    Record<string, { status: "idle" | "authorizing" | "success" | "error"; message?: string }>
  >({});
  const [testingServerId, setTestingServerId] = useState<string | null>(null);
  const [testResultsByServerId, setTestResultsByServerId] = useState<
    Record<string, { healthy: boolean; error?: string; toolCount?: number; timestamp: string }>
  >({});

  const replaceServer = (id: string, update: (server: McpServerConfig) => McpServerConfig) =>
    updateSettings({
      mcpServers: servers.map((server) => (server.id === id ? update(server) : server)),
    });

  const testConnection = async (server: McpServerConfig) => {
    setTestingServerId(server.id);
    try {
      if (primaryEnvironmentId) {
        const atomResult = await checkMcpHealth({
          environmentId: primaryEnvironmentId,
          input: { server },
        });
        if (atomResult._tag === "Success") {
          const result = atomResult.value;
          setTestResultsByServerId((prev) => ({
            ...prev,
            [server.id]: {
              healthy: result.healthy,
              ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.toolCount !== undefined ? { toolCount: result.toolCount } : {}),
              timestamp: new Date().toISOString(),
            },
          }));
        } else {
          setTestResultsByServerId((prev) => ({
            ...prev,
            [server.id]: {
              healthy: false,
              error: "RPC command failed",
              timestamp: new Date().toISOString(),
            },
          }));
        }
        return;
      }

      setTestResultsByServerId((prev) => ({
        ...prev,
        [server.id]: {
          healthy: false,
          error: "Connect to an environment before testing an MCP server.",
          timestamp: new Date().toISOString(),
        },
      }));
    } catch (err) {
      setTestResultsByServerId((prev) => ({
        ...prev,
        [server.id]: {
          healthy: false,
          error: err instanceof Error ? err.message : "Failed to test connection",
          timestamp: new Date().toISOString(),
        },
      }));
    } finally {
      setTestingServerId(null);
    }
  };

  const addServer = () => {
    let suffix = servers.length + 1;
    while (servers.some((server) => server.id === `mcp-server-${suffix}`)) suffix += 1;
    const id = `mcp-server-${suffix}`;
    updateSettings({
      mcpServers: [
        ...servers,
        {
          id,
          name: "New MCP server",
          enabled: true,
          transport: { type: "http", url: "http://127.0.0.1:3000/mcp", headers: [] },
        },
      ],
    });
  };

  return (
    <SettingsRow
      id="mcp-servers"
      title="Installed & custom MCP servers"
      description="Manage installed plugins and custom MCP connections. Add credentials, authorize OAuth servers, test connections, or connect a server manually. Changes apply to newly started sessions."
      control={
        <Button size="sm" variant="outline" onClick={addServer}>
          <PlusIcon /> Add server
        </Button>
      }
    >
      <div className="space-y-3 pb-3 pt-2">
        {servers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
            No external MCP servers are connected.
          </div>
        ) : null}
        {servers.map((server) => (
          <div
            key={server.id}
            className="rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4"
          >
            <div className="flex items-center gap-2">
              <ServerIcon className="size-4 text-muted-foreground" />
              <Input
                aria-label="MCP server name"
                defaultValue={server.name}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name && name !== server.name)
                    replaceServer(server.id, (value) => ({ ...value, name }));
                }}
              />
              <Switch
                checked={server.enabled}
                onCheckedChange={(enabled) =>
                  replaceServer(server.id, (value) => ({ ...value, enabled: Boolean(enabled) }))
                }
                aria-label={`Enable ${server.name}`}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Remove ${server.name}`}
                onClick={() =>
                  updateSettings({ mcpServers: servers.filter((value) => value.id !== server.id) })
                }
              >
                <Trash2Icon />
              </Button>
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <Select
                value={server.transport.type}
                onValueChange={(type) => {
                  if (type === server.transport.type) return;
                  replaceServer(server.id, (value) => ({
                    ...value,
                    transport:
                      type === "stdio"
                        ? { type: "stdio", command: "npx", args: [], environment: [] }
                        : { type: "http", url: "http://127.0.0.1:3000/mcp", headers: [] },
                  }));
                }}
              >
                <SelectTrigger aria-label="MCP transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="http">Remote HTTP</SelectItem>
                  <SelectItem value="stdio">Local command</SelectItem>
                </SelectPopup>
              </Select>

              {server.transport.type === "http" ? (
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label="MCP server URL"
                      defaultValue={server.transport.url}
                      className="min-w-[14rem] flex-1"
                      placeholder="https://example.com/mcp"
                      onBlur={(event) => {
                        const url = event.currentTarget.value.trim();
                        if (url)
                          replaceServer(server.id, (value) =>
                            value.transport.type === "http"
                              ? { ...value, transport: { ...value.transport, url } }
                              : value,
                          );
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={authorizingServerId === server.id}
                      onClick={async () => {
                        try {
                          setAuthorizingServerId(server.id);
                          setAuthStatusByServerId((prev) => ({
                            ...prev,
                            [server.id]: {
                              status: "authorizing",
                              message: "Waiting for authorization in your browser...",
                            },
                          }));

                          if (server.transport.type !== "http") {
                            throw new Error("Only Remote HTTP MCP servers support OAuth.");
                          }
                          const result = await authorizeMcpServerWithPopup(server.transport.url);
                          const tokenValue = `Bearer ${result.accessToken}`;

                          replaceServer(server.id, (value) => {
                            if (value.transport.type !== "http") return value;
                            const existingIndex = value.transport.headers.findIndex(
                              (h) => h.name.toLowerCase() === "authorization",
                            );
                            const nextHeaders =
                              existingIndex >= 0
                                ? value.transport.headers.map((h, i) =>
                                    i === existingIndex ? { ...h, value: tokenValue } : h,
                                  )
                                : [
                                    ...value.transport.headers,
                                    { name: "Authorization", value: tokenValue },
                                  ];

                            return {
                              ...value,
                              transport: {
                                ...value.transport,
                                headers: nextHeaders,
                              },
                            };
                          });

                          setAuthStatusByServerId((prev) => ({
                            ...prev,
                            [server.id]: {
                              status: "success",
                              message: "Authenticated successfully with OAuth!",
                            },
                          }));
                        } catch (err) {
                          setAuthStatusByServerId((prev) => ({
                            ...prev,
                            [server.id]: {
                              status: "error",
                              message: err instanceof Error ? err.message : String(err),
                            },
                          }));
                        } finally {
                          setAuthorizingServerId(null);
                        }
                      }}
                    >
                      {authorizingServerId === server.id ? (
                        <>
                          <Loader2Icon className="size-3.5 animate-spin" /> Authorizing...
                        </>
                      ) : (
                        <>
                          <KeyRoundIcon className="size-3.5 text-primary" /> Authorize with OAuth
                        </>
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={testingServerId === server.id || authorizingServerId === server.id}
                      onClick={() => testConnection(server)}
                    >
                      {testingServerId === server.id ? (
                        <>
                          <Loader2Icon className="size-3.5 animate-spin" /> Testing...
                        </>
                      ) : (
                        <>
                          <WifiIcon className="size-3.5 text-primary" /> Test Connection
                        </>
                      )}
                    </Button>
                  </div>

                  {authStatusByServerId[server.id]?.status === "authorizing" ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3.5 animate-spin text-primary" />
                      {authStatusByServerId[server.id]?.message}
                    </p>
                  ) : authStatusByServerId[server.id]?.status === "success" ? (
                    <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
                      <CheckCircle2Icon className="size-3.5" />
                      {authStatusByServerId[server.id]?.message}
                    </p>
                  ) : authStatusByServerId[server.id]?.status === "error" ? (
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <InfoIcon className="size-3.5" />
                      {authStatusByServerId[server.id]?.message}
                    </p>
                  ) : null}
                  {(() => {
                    const result = testResultsByServerId[server.id];
                    if (!result) return null;
                    return (
                      <p className="flex items-center gap-1.5 text-xs">
                        {result.healthy ? (
                          <>
                            <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                            <span className="font-medium text-emerald-500">Connection OK</span>
                            {result.toolCount !== undefined && (
                              <span className="text-muted-foreground">
                                ({result.toolCount} tools)
                              </span>
                            )}
                          </>
                        ) : (
                          <>
                            <InfoIcon className="size-3.5 text-destructive" />
                            <span className="text-destructive">Failed: {result.error}</span>
                          </>
                        )}
                        <span className="text-muted-foreground">
                          ({new Date(result.timestamp).toLocaleTimeString()})
                        </span>
                      </p>
                    );
                  })()}
                </div>
              ) : (
                <Input
                  aria-label="MCP server command"
                  defaultValue={server.transport.command}
                  placeholder="npx"
                  onBlur={(event) => {
                    const command = event.currentTarget.value.trim();
                    if (command)
                      replaceServer(server.id, (value) =>
                        value.transport.type === "stdio"
                          ? { ...value, transport: { ...value.transport, command } }
                          : value,
                      );
                  }}
                />
              )}
            </div>

            {server.transport.type === "stdio" ? (
              <div className="mt-3 space-y-2">
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  Arguments — one per line
                </label>
                <Textarea
                  defaultValue={server.transport.args.join("\n")}
                  rows={3}
                  onBlur={(event) => {
                    const args = event.currentTarget.value
                      .split(/\r?\n/)
                      .map((value) => value.trim())
                      .filter(Boolean);
                    replaceServer(server.id, (value) =>
                      value.transport.type === "stdio"
                        ? { ...value, transport: { ...value.transport, args } }
                        : value,
                    );
                  }}
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testingServerId === server.id}
                    onClick={() => testConnection(server)}
                  >
                    {testingServerId === server.id ? (
                      <>
                        <Loader2Icon className="size-3.5 animate-spin" /> Testing...
                      </>
                    ) : (
                      <>
                        <WifiIcon className="size-3.5 text-primary" /> Test Connection
                      </>
                    )}
                  </Button>
                </div>
                {(() => {
                  const result = testResultsByServerId[server.id];
                  if (!result) return null;
                  return (
                    <p className="flex items-center gap-1.5 text-xs">
                      {result.healthy ? (
                        <>
                          <CheckCircle2Icon className="size-3.5 text-emerald-500" />
                          <span className="font-medium text-emerald-500">Connection OK</span>
                          {result.toolCount !== undefined && (
                            <span className="text-muted-foreground">
                              ({result.toolCount} tools)
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <InfoIcon className="size-3.5 text-destructive" />
                          <span className="text-destructive">Failed: {result.error}</span>
                        </>
                      )}
                      <span className="text-muted-foreground">
                        ({new Date(result.timestamp).toLocaleTimeString()})
                      </span>
                    </p>
                  );
                })()}
              </div>
            ) : null}

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {server.transport.type === "http" ? "Request headers" : "Environment variables"}
                </span>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  onClick={() =>
                    replaceServer(server.id, (value) =>
                      value.transport.type === "http"
                        ? {
                            ...value,
                            transport: {
                              ...value.transport,
                              headers: [
                                ...value.transport.headers,
                                { name: "Authorization", value: "" },
                              ],
                            },
                          }
                        : {
                            ...value,
                            transport: {
                              ...value.transport,
                              environment: [
                                ...value.transport.environment,
                                { name: "API_KEY", value: "" },
                              ],
                            },
                          },
                    )
                  }
                >
                  <PlusIcon /> Add
                </Button>
              </div>
              {(server.transport.type === "http"
                ? server.transport.headers
                : server.transport.environment
              ).map((entry, index) => (
                <div
                  key={`${entry.name}-${index}`}
                  className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_2rem] gap-2"
                >
                  <Input
                    aria-label="Name"
                    defaultValue={entry.name}
                    placeholder="Name"
                    onBlur={(event) => {
                      const name = event.currentTarget.value.trim();
                      if (!name) return;
                      replaceServer(server.id, (value) => {
                        if (value.transport.type === "http")
                          return {
                            ...value,
                            transport: {
                              ...value.transport,
                              headers: value.transport.headers.map((item, itemIndex) =>
                                itemIndex === index ? { ...item, name } : item,
                              ),
                            },
                          };
                        return {
                          ...value,
                          transport: {
                            ...value.transport,
                            environment: value.transport.environment.map((item, itemIndex) =>
                              itemIndex === index ? { ...item, name } : item,
                            ),
                          },
                        };
                      });
                    }}
                  />
                  <Input
                    type="password"
                    aria-label="Value"
                    defaultValue=""
                    placeholder={entry.valueRedacted ? "Saved" : "Value"}
                    onBlur={(event) => {
                      const valueText = event.currentTarget.value;
                      if (!valueText) return;
                      replaceServer(server.id, (value) => {
                        if (value.transport.type === "http")
                          return {
                            ...value,
                            transport: {
                              ...value.transport,
                              headers: value.transport.headers.map((item, itemIndex) =>
                                itemIndex === index ? { name: item.name, value: valueText } : item,
                              ),
                            },
                          };
                        return {
                          ...value,
                          transport: {
                            ...value.transport,
                            environment: value.transport.environment.map((item, itemIndex) =>
                              itemIndex === index ? { name: item.name, value: valueText } : item,
                            ),
                          },
                        };
                      });
                    }}
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label="Remove value"
                    onClick={() =>
                      replaceServer(server.id, (value) =>
                        value.transport.type === "http"
                          ? {
                              ...value,
                              transport: {
                                ...value.transport,
                                headers: value.transport.headers.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              },
                            }
                          : {
                              ...value,
                              transport: {
                                ...value.transport,
                                environment: value.transport.environment.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              },
                            },
                      )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SettingsRow>
  );
}

export function IntegrationsSettingsPanel() {
  // Client-local preview defaults are editable only where the preview exists.
  const previewDefaultsDisabled = !isElectron;
  const previewDefaults = (
    <>
      <BrowserViewportSetting disabled={previewDefaultsDisabled} />
      <BrowserZoomSetting disabled={previewDefaultsDisabled} />
      <BrowserAppearanceSetting disabled={previewDefaultsDisabled} />
      <BrowserAutoShowFloatingPreviewSetting disabled={previewDefaultsDisabled} />
    </>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="image-generation" title="ShiryuGen · Generation & Engine">
        <ImageGenerationSettings />
      </SettingsSection>
      <SettingsSection id="installed-plugins" title="Installed Plugins">
        <BuiltInIntegrationsSetting />
        <McpServersSetting />
      </SettingsSection>
      <SettingsSection id="discover-plugins" title="Discover Plugins">
        <McpPluginCatalogSetting />
      </SettingsSection>
      <SettingsSection id="skills" title="Skills">
        <T3SkillsSetting />
      </SettingsSection>
      <SettingsSection id="browser" title="Browser">
        {/* Server-authoritative, so it stays editable on every client and sits
            outside the block covering the desktop-only defaults. */}
        <AgentBrowserAccessSetting />
        {previewDefaultsDisabled ? (
          <DesktopOnlyBrowserDefaults>{previewDefaults}</DesktopOnlyBrowserDefaults>
        ) : (
          previewDefaults
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
