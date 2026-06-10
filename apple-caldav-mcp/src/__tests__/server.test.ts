import test from "node:test";
import assert from "node:assert/strict";
import { getRequestDecision, registerSignalHandlers } from "../server.js";

test("health requires bearer auth before routing", () => {
  const result = getRequestDecision({
    pathname: "/health",
    method: "GET",
    authorization: undefined,
    expectedBearerToken: "secret"
  });

  assert.deepEqual(result, {
    kind: "unauthorized",
    statusCode: 401
  });
});

test("authorization accepts bearer scheme case-insensitively", () => {
  const result = getRequestDecision({
    pathname: "/health",
    method: "GET",
    authorization: "bearer secret",
    expectedBearerToken: "secret"
  });

  assert.deepEqual(result, {
    kind: "health",
    statusCode: 200
  });
});

test("authorization rejects headers with extra segments", () => {
  const result = getRequestDecision({
    pathname: "/mcp",
    method: "POST",
    authorization: "Bearer secret extra",
    expectedBearerToken: "secret"
  });

  assert.deepEqual(result, {
    kind: "unauthorized",
    statusCode: 401
  });
});

test("mcp route preserves method guard after auth succeeds", () => {
  const result = getRequestDecision({
    pathname: "/mcp",
    method: "GET",
    authorization: "Bearer secret",
    expectedBearerToken: "secret"
  });

  assert.deepEqual(result, {
    kind: "mcp_method_not_allowed",
    statusCode: 405,
    allow: "POST"
  });
});

test("registerSignalHandlers only registers process handlers once", () => {
  const listeners: { SIGINT: Array<() => void>; SIGTERM: Array<() => void> } = {
    SIGINT: [],
    SIGTERM: []
  };
  const fakeProcess = {
    on(signal: "SIGINT" | "SIGTERM", handler: () => void) {
      listeners[signal].push(handler);
      return fakeProcess;
    },
    exitCode: 0,
    exit() {}
  };
  const fakeServer = {
    close(_callback: (error?: Error | undefined) => void) {}
  };

  registerSignalHandlers(fakeServer, fakeProcess);
  registerSignalHandlers(fakeServer, fakeProcess);

  assert.equal(listeners.SIGINT.length, 1);
  assert.equal(listeners.SIGTERM.length, 1);
});
