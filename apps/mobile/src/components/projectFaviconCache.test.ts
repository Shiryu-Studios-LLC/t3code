import { describe, expect, it } from "vite-plus/test";

import {
  beginProjectFaviconRequest,
  createProjectFaviconRequest,
  isCurrentProjectFaviconRequest,
} from "./projectFaviconCache";

describe("project favicon cache", () => {
  it("ignores callbacks from a superseded URL", () => {
    const cacheKey = "environment-1:/workspace:v1-favicon.svg";
    const expiredUrl = "https://environment.example/api/assets/expired/v1-favicon.svg";
    const refreshedUrl = "https://environment.example/api/assets/refreshed/v1-favicon.svg";

    const expiredRequest = createProjectFaviconRequest(cacheKey, expiredUrl);
    const endExpiredRequest = beginProjectFaviconRequest(expiredRequest);
    const refreshedRequest = createProjectFaviconRequest(cacheKey, refreshedUrl);
    const endRefreshedRequest = beginProjectFaviconRequest(refreshedRequest);

    expect(isCurrentProjectFaviconRequest(expiredRequest)).toBe(false);
    expect(isCurrentProjectFaviconRequest(refreshedRequest)).toBe(true);

    endRefreshedRequest();
    endExpiredRequest();
  });

  it("does not supersede a request until the next request begins", () => {
    const cacheKey = "environment-1:/workspace:v3-favicon.svg";
    const committedUrl = "https://environment.example/api/assets/current/v3-favicon.svg";
    const abandonedUrl = "https://environment.example/api/assets/abandoned/v3-favicon.svg";
    const committedRequest = createProjectFaviconRequest(cacheKey, committedUrl);
    const endCommittedRequest = beginProjectFaviconRequest(committedRequest);

    createProjectFaviconRequest(cacheKey, abandonedUrl);

    expect(isCurrentProjectFaviconRequest(committedRequest)).toBe(true);

    endCommittedRequest();
  });

  it("requires a cache key before creating a URL-bearing request", () => {
    const firstUrl = "https://environment.example/api/assets/first/favicon.svg";
    const secondUrl = "https://environment.example/api/assets/second/favicon.svg";

    expect(createProjectFaviconRequest(null, firstUrl)).toBeNull();
    expect(createProjectFaviconRequest(null, secondUrl)).toBeNull();
  });

  it("restores the remaining active URL when a newer request ends", () => {
    const cacheKey = "environment-1:/workspace:v4-favicon.svg";
    const firstRequest = createProjectFaviconRequest(
      cacheKey,
      "https://environment.example/api/assets/first/v4-favicon.svg",
    );
    const secondRequest = createProjectFaviconRequest(
      cacheKey,
      "https://environment.example/api/assets/second/v4-favicon.svg",
    );
    const endFirstRequest = beginProjectFaviconRequest(firstRequest);
    const endSecondRequest = beginProjectFaviconRequest(secondRequest);

    expect(isCurrentProjectFaviconRequest(firstRequest)).toBe(false);
    endSecondRequest();
    expect(isCurrentProjectFaviconRequest(firstRequest)).toBe(true);
    endFirstRequest();
    expect(isCurrentProjectFaviconRequest(firstRequest)).toBe(false);
  });
});
