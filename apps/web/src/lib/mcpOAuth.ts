/**
 * MCP OAuth 2.0 PKCE helper for authenticating remote HTTP MCP servers (e.g. DevSpace).
 * Implements RFC 8414, RFC 7591 (Dynamic Client Registration), and RFC 7636 (PKCE).
 */

export interface McpOAuthMetadata {
  readonly authorizationServer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string | undefined;
  readonly scopesSupported: ReadonlyArray<string>;
}

export interface McpOAuthResult {
  readonly accessToken: string;
  readonly tokenType?: string | undefined;
  readonly scope?: string | undefined;
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function generatePkce(): Promise<{
  verifier: string;
  challenge: string;
  state: string;
}> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const verifier = base64UrlEncode(randomBytes.buffer);

  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = base64UrlEncode(stateBytes.buffer);

  const encoder = new TextEncoder();
  const verifierData = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", verifierData);
  const challenge = base64UrlEncode(hashBuffer);

  return { verifier, challenge, state };
}

export async function discoverMcpOAuthMetadata(mcpUrl: string): Promise<McpOAuthMetadata | null> {
  try {
    const url = new URL(mcpUrl);
    const origin = url.origin;

    // 1. Check if resource metadata URL exists
    const resourceMetaUrls = [
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      `${origin}/.well-known/oauth-protected-resource`,
    ];

    let authServerUrl: string = origin;
    let scopes: string[] = ["devspace"];

    for (const metaUrl of resourceMetaUrls) {
      try {
        const res = await fetch(metaUrl);
        if (res.ok) {
          const meta = (await res.json()) as {
            authorization_servers?: string[];
            scopes_supported?: string[];
          };
          const firstServer = meta.authorization_servers?.[0];
          if (firstServer) {
            authServerUrl = firstServer.replace(/\/+$/, "");
          }
          if (meta.scopes_supported && meta.scopes_supported.length > 0) {
            scopes = meta.scopes_supported;
          }
          break;
        }
      } catch {
        // Ignore and fallback
      }
    }

    // 2. Fetch authorization server metadata from RFC 8414 endpoint
    const authServerMetaUrl = `${authServerUrl}/.well-known/oauth-authorization-server`;
    try {
      const res = await fetch(authServerMetaUrl);
      if (res.ok) {
        const meta = (await res.json()) as {
          authorization_endpoint?: string;
          token_endpoint?: string;
          registration_endpoint?: string;
          scopes_supported?: string[];
        };
        if (meta.authorization_endpoint && meta.token_endpoint) {
          return {
            authorizationServer: authServerUrl,
            authorizationEndpoint: meta.authorization_endpoint,
            tokenEndpoint: meta.token_endpoint,
            registrationEndpoint: meta.registration_endpoint,
            scopesSupported: meta.scopes_supported ?? scopes,
          };
        }
      }
    } catch {
      // Fallback
    }

    // 3. Defaults for standard OAuth servers
    return {
      authorizationServer: authServerUrl,
      authorizationEndpoint: `${authServerUrl}/authorize`,
      tokenEndpoint: `${authServerUrl}/token`,
      registrationEndpoint: `${authServerUrl}/register`,
      scopesSupported: scopes,
    };
  } catch (error) {
    console.warn("[mcp-oauth] Failed to discover OAuth metadata:", error);
    return null;
  }
}

export async function registerMcpOAuthClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName = "T3 Studio",
  scope = "devspace",
): Promise<string | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as { client_id?: string };
      return data.client_id ?? null;
    }
  } catch (error) {
    console.warn("[mcp-oauth] Failed dynamic client registration:", error);
  }
  return null;
}

export async function authorizeMcpServerWithPopup(mcpUrl: string): Promise<McpOAuthResult> {
  const metadata = await discoverMcpOAuthMetadata(mcpUrl);
  if (!metadata) {
    throw new Error(`Unable to discover OAuth endpoints for MCP server: ${mcpUrl}`);
  }

  const redirectUri = `${window.location.origin}/oauth-callback.html`;
  const { verifier, challenge, state } = await generatePkce();

  // Dynamic registration or fallback client_id
  let clientId: string | null = null;
  if (metadata.registrationEndpoint) {
    clientId = await registerMcpOAuthClient(
      metadata.registrationEndpoint,
      redirectUri,
      "T3 Studio",
      metadata.scopesSupported.join(" ") || "devspace",
    );
  }

  if (!clientId) {
    // If registration is not supported, use standard client identifier
    clientId = "t3-studio-client";
  }

  const scopeParam = metadata.scopesSupported.join(" ") || "devspace";
  const authUrl = new URL(metadata.authorizationEndpoint);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopeParam);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  // Open Popup Window
  const width = 600;
  const height = 750;
  const left = window.screenX + (window.outerWidth - width) / 2;
  const top = window.screenY + (window.outerHeight - height) / 2;

  const popup = window.open(
    authUrl.toString(),
    "t3-mcp-oauth",
    `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes,scrollbars=yes`,
  );

  if (!popup) {
    throw new Error("Popup blocked by browser. Please allow popups for T3 Studio to authorize.");
  }

  // Wait for postMessage callback
  const code = await new Promise<string>((resolve, reject) => {
    let cleanup: () => void = () => {};

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Authentication timed out after 2 minutes."));
    }, 120_000);

    const messageHandler = (event: MessageEvent) => {
      const data = event.data as {
        type?: string;
        code?: string;
        state?: string;
        error?: string;
      } | null;

      if (!data || data.type !== "t3-mcp-oauth-callback") return;

      if (data.error) {
        cleanup();
        reject(new Error(`OAuth Authorization Error: ${data.error}`));
        return;
      }

      if (data.code && (!data.state || data.state === state)) {
        cleanup();
        resolve(data.code);
      }
    };

    const pollClosed = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new Error("Authorization popup window was closed before completing."));
      }
    }, 1000);

    cleanup = () => {
      clearTimeout(timer);
      clearInterval(pollClosed);
      window.removeEventListener("message", messageHandler);
    };

    window.addEventListener("message", messageHandler);
  });

  // Exchange code for token at tokenEndpoint
  const tokenParams = new URLSearchParams();
  tokenParams.set("grant_type", "authorization_code");
  tokenParams.set("code", code);
  tokenParams.set("redirect_uri", redirectUri);
  tokenParams.set("client_id", clientId);
  tokenParams.set("code_verifier", verifier);

  const tokenRes = await fetch(metadata.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: tokenParams.toString(),
  });

  if (!tokenRes.ok) {
    const errorBody = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${errorBody}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
  };

  if (!tokenData.access_token) {
    throw new Error("No access_token returned by authorization server.");
  }

  return {
    accessToken: tokenData.access_token,
    tokenType: tokenData.token_type,
    scope: tokenData.scope,
  };
}
