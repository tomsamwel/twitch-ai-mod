import type { AiDecision, AiDecisionInput, AiProviderKind } from "../types.js";

export interface AiProvider {
  readonly kind: AiProviderKind;
  healthCheck(): Promise<void>;
  decide(input: AiDecisionInput): Promise<AiDecision>;
}
