# Plugins, apps, and skills

T3 Studio can extend an agent with external tools through Model Context Protocol (MCP) servers. A plugin can expose actions or data from another service, while provider-native skills add reusable instructions and workflows to a coding provider.

## Find and install a plugin

In the web or desktop client, open **Settings → Integrations → Plugins & Apps** and use **Plugin catalog** to search the official MCP Registry by server name. Plugins are stored on the environment, so mobile sessions connected to that environment can use them even though plugin management is not yet exposed in the native mobile Settings UI.

Each compatible registry entry shows one or more install choices. T3 Studio currently supports:

- Remote MCP servers that use Streamable HTTP or SSE.
- Simple npm MCP packages that run locally over stdio.

Choose **Install** to add a ready-to-use connection. Choose **Add & configure** when the registry entry declares required credentials or environment settings. Registry entries that need URL templates or custom command-line arguments remain available for manual setup instead of being installed with guessed values.

Plugins are third-party software. Review the service, source repository, permissions, and requested credentials before connecting it. Local npm plugins execute code on the environment where T3 Studio is running.

## Authenticate and test a plugin

Installed plugins appear under **Installed & custom MCP servers** on the same page. From there you can:

- Enable or disable a connection.
- Authorize compatible remote servers with OAuth.
- Add request headers such as API tokens.
- Add environment variables for local plugins.
- Test the connection and see how many MCP tools the server exposes.
- Remove a plugin or custom server.

Credential values are hidden when settings are sent back to a client. A saved secret stays on the environment that owns the T3 Studio server.

Changes apply to newly started provider sessions. If a thread already has an active provider session, start a new session before expecting a newly installed plugin to appear there.

## Connect a server manually

If the service is not in the registry, select **Add server** under **Installed & custom MCP servers**.

For a hosted integration, choose **Remote HTTP** and enter its MCP URL. Add any required headers or use **Authorize with OAuth** when the service supports MCP OAuth.

For a local integration, choose **Local command** and enter the executable, one command argument per line, and any required environment variables.

Use **Test Connection** before relying on the integration in an agent session.

## How plugins reach agents

T3 Studio stores an MCP connection once at the environment level and projects it into supported provider runtimes. This avoids maintaining separate copies of the same integration for Codex, Claude, Cursor-compatible ACP sessions, OpenCode, and direct model sessions.

The exact tools and approval behavior still come from the connected MCP server and the active provider. Connecting a plugin does not guarantee that every provider exposes every action in exactly the same way.

## Skills are different from plugins

A **plugin** gives the model access to external tools or data. A **skill** teaches an agent a repeatable workflow.

T3 Studio supports two kinds of skills. Provider-native skills are discovered from supported providers such as Codex and OpenCode. **T3 Skills** are environment-owned workflows that you create in **Settings → Integrations → Skills**. T3 Skills are provider-neutral: T3 Studio expands their instructions before a turn is sent, so the same skill can be used with Codex, Claude, Cursor, Grok, OpenCode, Gemini, or another compatible provider.

Create a T3 Skill with a short composer name, description, and workflow instructions. Enabled T3 Skills appear in the same composer skill picker as provider-native skills. Type `$` and choose the skill, or type its token directly, such as `$stream-setup`. If a provider already owns a native skill with the same name, the provider-native skill stays authoritative in that provider's picker.

Skills are useful for workflows such as code review, release procedures, stream setup, order preparation, or project-specific conventions. Plugins are the better fit for actions such as reading an external service, looking up an order, creating a ticket, controlling another application, or placing an approved order.

A workflow can use both: a skill describes _how_ to perform a task while one or more MCP plugins provide the external actions needed to complete it.
