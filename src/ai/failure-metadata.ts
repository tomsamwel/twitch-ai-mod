import type { AiDecision } from "../types.js";

export interface AiFailureMetadata {
  failureKind: string | null;
  errorType: string | null;
}

export function getAiFailureMetadata(decision: AiDecision | null | undefined): AiFailureMetadata {
  const metadata = decision?.metadata;

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {
      failureKind: null,
      errorType: null,
    };
  }

  const candidate = metadata as Record<string, unknown>;

  return {
    failureKind: typeof candidate.failureKind === "string" ? candidate.failureKind : null,
    errorType: typeof candidate.errorType === "string" ? candidate.errorType : null,
  };
}
