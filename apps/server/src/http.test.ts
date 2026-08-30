import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import { HttpRouter } from "effect/unstable/http";

import {
  assetResponseHeaders,
  isLoopbackHostname,
  mcpOAuthCallbackRouteLayer,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });
});

describe("MCP OAuth callback", () => {
  it("relays an authorization result exactly once", async () => {
    const { handler, dispose } = HttpRouter.toWebHandler(mcpOAuthCallbackRouteLayer, {
      disableLogger: true,
    });
    const state = "test-oauth-state";

    try {
      const posted = await handler(
        new Request("http://localhost/api/mcp/oauth/callback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state, code: "authorization-code" }),
        }),
      );
      expect(posted.status).toBe(200);
      await expect(posted.json()).resolves.toEqual({ ok: true });

      const callbackUrl = `http://localhost/api/mcp/oauth/callback?state=${state}`;
      const received = await handler(new Request(callbackUrl));
      expect(received.status).toBe(200);
      await expect(received.json()).resolves.toEqual({
        found: true,
        code: "authorization-code",
      });

      const consumed = await handler(new Request(callbackUrl));
      expect(consumed.status).toBe(200);
      await expect(consumed.json()).resolves.toEqual({ found: false });
    } finally {
      await dispose();
    }
  });
});
