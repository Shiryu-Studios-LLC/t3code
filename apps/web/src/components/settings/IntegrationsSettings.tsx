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
  type McpServerConfig,
} from "@t3tools/contracts";
import { PREVIEW_VIEWPORT_PRESETS } from "@t3tools/shared/previewViewport";
import {
  CheckCircle2Icon,
  InfoIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlusIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { ScreenRotationIcon } from "~/browser/ScreenRotationIcon";
import { authorizeMcpServerWithPopup } from "~/lib/mcpOAuth";
import { isElectron } from "../../env";

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
      description="Let agents open and drive the preview browser. When off, the browser tools and the instructions describing them are withheld from agent sessions. Your own browser panel is unaffected."
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

function McpServersSetting() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const servers = settings.mcpServers;
  const [authorizingServerId, setAuthorizingServerId] = useState<string | null>(null);
  const [authStatusByServerId, setAuthStatusByServerId] = useState<
    Record<string, { status: "idle" | "authorizing" | "success" | "error"; message?: string }>
  >({});

  const replaceServer = (id: string, update: (server: McpServerConfig) => McpServerConfig) =>
    updateSettings({
      mcpServers: servers.map((server) => (server.id === id ? update(server) : server)),
    });

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
      title="MCP servers"
      description="Connect shared tool servers once. T3 Studio makes their tools available to every supported agent and direct model session. Changes apply to newly started sessions."
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
              <div className="mt-3">
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
      <SettingsSection id="mcp" title="Model Context Protocol">
        <McpServersSetting />
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
