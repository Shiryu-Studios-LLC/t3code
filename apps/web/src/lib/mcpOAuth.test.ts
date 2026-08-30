import { describe, expect, it } from "vite-plus/test";
import { generatePkce, discoverMcpOAuthMetadata, registerMcpOAuthClient } from "./mcpOAuth";

describe("mcpOAuth", () => {
  it("generates valid PKCE verifier, challenge, and state", async () => {
    const pkce = await generatePkce();
    expect(pkce.verifier).toBeTruthy();
    expect(pkce.challenge).toBeTruthy();
    expect(pkce.state).toBeTruthy();

    // Verifier should be a base64url string without padding
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.verifier).not.toBe(pkce.challenge);
  });

  it("discovers OAuth metadata from live DevSpace server", async () => {
    const metadata = await discoverMcpOAuthMetadata("https://devspace.shiryu.org/mcp");
    expect(metadata).not.toBeNull();
    expect(metadata?.authorizationServer).toBe("https://devspace.shiryu.org");
    expect(metadata?.authorizationEndpoint).toBe("https://devspace.shiryu.org/authorize");
    expect(metadata?.tokenEndpoint).toBe("https://devspace.shiryu.org/token");
    expect(metadata?.registrationEndpoint).toBe("https://devspace.shiryu.org/register");
    expect(metadata?.scopesSupported).toContain("devspace");
  });

  it("successfully registers dynamic client with DevSpace OAuth server", async () => {
    const clientId = await registerMcpOAuthClient(
      "https://devspace.shiryu.org/register",
      "http://localhost:3773/oauth-callback.html",
      "T3 Studio Test",
      "devspace",
    );
    expect(clientId).toBeTruthy();
    expect(typeof clientId).toBe("string");
    expect(clientId?.startsWith("devspace-")).toBe(true);
  });
});
