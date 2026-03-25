import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderRegistry, createAiProvider } from "../src/ai/provider-registry.js";
import { OllamaAiProvider } from "../src/ai/providers/ollama.js";
import { OpenAiAiProvider } from "../src/ai/providers/openai.js";
import { createLogger } from "../src/storage/logger.js";
import { createChatEvent, createEmptyContext, createTestConfig, withMockFetch } from "./helpers.js";
import { buildAiDecisionInput } from "../src/ai/prompt.js";
import { normalizeChatMessage } from "../src/ingest/normalize-chat-message.js";

test("createAiProvider selects Ollama and invokes startup health check", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  let tagsChecked = false;

  await withMockFetch(
    (async (input) => {
      const url = String(input);

      if (url.endsWith("/api/tags")) {
        tagsChecked = true;
        return new Response(
          JSON.stringify({
            models: [{ model: config.ai.ollama.model }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }) as typeof fetch,
    async () => {
      const provider = await createAiProvider(config, logger);

      assert.ok(provider instanceof OllamaAiProvider);
      assert.equal(tagsChecked, true);
    },
  );
});

test("createAiProvider selects OpenAI and invokes startup health check", async () => {
  const config = createTestConfig();
  config.ai.provider = "openai";
  const logger = createLogger("info", "test");
  let modelChecked = false;

  await withMockFetch(
    (async (input) => {
      const url = String(input);

      if (url.includes("/models/")) {
        modelChecked = true;
        return new Response(
          JSON.stringify({
            id: config.ai.openai.model,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }) as typeof fetch,
    async () => {
      const provider = await createAiProvider(config, logger);

      assert.ok(provider instanceof OpenAiAiProvider);
      assert.equal(modelChecked, true);
    },
  );
});

test("Ollama provider returns abstain when the local runtime is unreachable", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const provider = new OllamaAiProvider(config, logger);
  const input = buildAiDecisionInput(normalizeChatMessage(createChatEvent()), createEmptyContext(), config, {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  });

  await withMockFetch(
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
    async () => {
      const decision = await provider.decide(input);

      assert.equal(decision.outcome, "abstain");
      assert.equal(decision.source, "ollama");
      assert.deepEqual(decision.metadata, {
        failureKind: "request_failed",
        errorType: "Error",
      });
    },
  );
});

test("OpenAI provider maps a structured response into an action decision", async () => {
  const config = createTestConfig();
  config.ai.provider = "openai";
  const logger = createLogger("info", "test");
  const provider = new OpenAiAiProvider(config, logger);
  const input = buildAiDecisionInput(normalizeChatMessage(createChatEvent()), createEmptyContext(), config, {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  });

  await withMockFetch(
    (async (resource) => {
      const url = String(resource);

      if (url.endsWith("/responses")) {
        return new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              outcome: "action",
              reason: "reply helps",
              confidence: 0.9,
              mode: "social",
              actions: [
                {
                  kind: "say",
                  reason: "brief reply",
                  message: "hello!",
                },
              ],
            }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }) as typeof fetch,
    async () => {
      const decision = await provider.decide(input);

      assert.equal(decision.outcome, "action");
      assert.equal(decision.actions[0]?.kind, "say");
      assert.equal(decision.source, "openai");
    },
  );
});

test("OpenAI provider abstains cleanly on auth failure", async () => {
  const config = createTestConfig();
  config.ai.provider = "openai";
  const logger = createLogger("info", "test");
  const provider = new OpenAiAiProvider(config, logger);
  const input = buildAiDecisionInput(normalizeChatMessage(createChatEvent()), createEmptyContext(), config, {
    id: "bot-1",
    login: "testbot",
    displayName: "TestBot",
  });

  await withMockFetch(
    (async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Invalid API key",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch,
    async () => {
      const decision = await provider.decide(input);

      assert.equal(decision.outcome, "abstain");
      assert.equal(decision.source, "openai");
      assert.deepEqual(decision.metadata, {
        failureKind: "request_failed",
        errorType: "Error",
      });
    },
  );
});

test("AiProviderRegistry reuses the same provider instance for the same effective config", async () => {
  const config = createTestConfig();
  const logger = createLogger("info", "test");
  const registry = new AiProviderRegistry(config, logger);

  await withMockFetch(
    (async (input) => {
      const url = String(input);

      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ model: config.ai.ollama.model }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      throw new Error(`Unexpected fetch to ${url}`);
    }) as typeof fetch,
    async () => {
      const first = await registry.getProvider(config);
      const second = await registry.getProvider(config);

      assert.equal(first, second);
      assert.ok(first instanceof OllamaAiProvider);
    },
  );
});
