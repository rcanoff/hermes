import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";

test("loadConfig returns validated runtime settings", () => {
  const config = loadConfig({
    PORT: "3000",
    MCP_BEARER_TOKEN: "secret",
    APPLE_CALDAV_URL: "https://caldav.icloud.com",
    APPLE_CALDAV_USERNAME: "user@example.com",
    APPLE_CALDAV_APP_PASSWORD: "app-password"
  });

  assert.equal(config.port, 3000);
  assert.equal(config.mcpBearerToken, "secret");
  assert.equal(config.caldavUrl, "https://caldav.icloud.com");
});

test("loadConfig rejects invalid port values", () => {
  for (const port of ["abc", "3.14", "-1", "70000"]) {
    assert.throws(() =>
      loadConfig({
        PORT: port,
        MCP_BEARER_TOKEN: "secret",
        APPLE_CALDAV_URL: "https://caldav.icloud.com",
        APPLE_CALDAV_USERNAME: "user@example.com",
        APPLE_CALDAV_APP_PASSWORD: "app-password"
      })
    );
  }
});
