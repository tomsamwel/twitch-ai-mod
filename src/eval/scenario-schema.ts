import { z } from "zod";

const actorRolesSchema = z.enum(["viewer", "vip", "subscriber", "moderator", "broadcaster", "trusted"]);

const scenarioActorSchema = z.object({
  id: z.string().min(1),
  login: z.string().min(1),
  displayName: z.string().min(1).optional(),
  roles: z.array(actorRolesSchema).default(["viewer"]),
});

const scenarioMessageSchema = z.object({
  id: z.string().min(1).optional(),
  at: z.string().min(1),
  actor: scenarioActorSchema,
  text: z.string().min(1),
  replyToBot: z.boolean().optional(),
});

const scenarioBotInteractionSchema = z
  .object({
    id: z.string().min(1).optional(),
    at: z.string().min(1),
    kind: z.enum(["say", "warn", "timeout"]),
    targetActorId: z.string().min(1).optional(),
    source: z.enum(["rules", "ai"]).default("ai"),
    status: z.enum(["executed", "dry-run", "skipped", "failed"]).default("executed"),
    reason: z.string().min(1),
    message: z.string().min(1).optional(),
    durationSeconds: z.number().int().positive().optional(),
    externalMessageId: z.string().min(1).optional(),
  })
  .superRefine((interaction, context) => {
    if ((interaction.kind === "say" || interaction.kind === "warn") && !interaction.message) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${interaction.kind} interactions must include a message`,
        path: ["message"],
      });
    }
  });

const scenarioExpectedSchema = z.object({
  mode: z.enum(["social", "moderation"]).optional(),
  allowedOutcomes: z.array(z.enum(["no_action", "suppressed", "abstain", "action", "ignored"])).min(1),
  allowedActionKinds: z.array(z.enum(["say", "warn", "timeout"])).default([]),
  requiredActionKinds: z.array(z.enum(["say", "warn", "timeout"])).default([]),
  requiredActionOrder: z.array(z.enum(["say", "warn", "timeout"])).optional(),
  allowedActionStatuses: z.array(z.enum(["executed", "dry-run", "skipped", "failed"])).default([]),
  forbiddenActionKinds: z.array(z.enum(["say", "warn", "timeout"])).default([]),
  replyShouldContainAny: z.array(z.string().min(1)).optional(),
  replyShouldNotContainAny: z.array(z.string().min(1)).optional(),
  scoring: z
    .object({
      missedTimeoutSeverity: z.enum(["advisory", "blocking"]).optional(),
    })
    .optional(),
});

const scenarioStepSchema = scenarioMessageSchema.extend({
  expected: scenarioExpectedSchema,
});

const scenarioSeedSchema = z
  .object({
    messages: z.array(scenarioMessageSchema).default([]),
    botInteractions: z.array(scenarioBotInteractionSchema).default([]),
  })
  .default({ messages: [], botInteractions: [] });

const scenarioCommonSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  category: z
    .enum([
      "adversarial",
      "edge-cases",
      "escalation",
      "future-warn-candidates",
      "harassment-sexual",
      "irl-safety",
      "loops-cooldowns",
      "moderation",
      "privileged-safety",
      "promo-scam",
      "social",
      "social-direct",
      "social-quiet",
    ])
    .default("moderation"),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  tags: z.array(z.string().min(1)).default([]),
  source: z.enum(["curated", "promoted-replay"]).default("curated"),
  futurePreferredAction: z.enum(["none", "say", "warn", "timeout"]).default("none"),
  approval: z
    .object({
      hardSafetyBlocker: z.boolean().default(false),
    })
    .default({
      hardSafetyBlocker: false,
    }),
});

const scriptedScenarioSchema = scenarioCommonSchema.extend({
  seed: scenarioSeedSchema,
  steps: z.array(scenarioStepSchema).min(1),
});

const legacyScenarioSchema = scenarioCommonSchema.extend({
  history: z
    .object({
      messages: z.array(scenarioMessageSchema).default([]),
      botInteractions: z.array(scenarioBotInteractionSchema).default([]),
    })
    .default({ messages: [], botInteractions: [] }),
  incomingMessage: scenarioMessageSchema,
  expected: scenarioExpectedSchema,
});

export const scenarioInputSchema = z.union([scriptedScenarioSchema, legacyScenarioSchema]);

export const scenarioFileSchema = scriptedScenarioSchema;

export type ScenarioInputFile = z.input<typeof scenarioInputSchema>;
export type ScenarioFile = z.infer<typeof scenarioFileSchema>;
export type ScenarioMessageSpec = z.infer<typeof scenarioMessageSchema>;
export type ScenarioBotInteractionSpec = z.infer<typeof scenarioBotInteractionSchema>;
export type ScenarioStepSpec = z.infer<typeof scenarioStepSchema>;

export function normalizeScenarioFile(input: ScenarioInputFile): ScenarioFile {
  if ("steps" in input) {
    return scenarioFileSchema.parse(input);
  }

  return scenarioFileSchema.parse({
    id: input.id,
    description: input.description,
    category: input.category,
    severity: input.severity,
    tags: input.tags,
    source: input.source,
    futurePreferredAction: input.futurePreferredAction,
    approval: input.approval,
    seed: {
      messages: input.history?.messages ?? [],
      botInteractions: input.history?.botInteractions ?? [],
    },
    steps: [
      {
        id: input.incomingMessage.id ?? `${input.id}-step-1`,
        at: input.incomingMessage.at,
        actor: input.incomingMessage.actor,
        text: input.incomingMessage.text,
        ...(input.incomingMessage.replyToBot ? { replyToBot: input.incomingMessage.replyToBot } : {}),
        expected: input.expected,
      },
    ],
  });
}
