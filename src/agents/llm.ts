import type { z } from "zod";
import type { Effort } from "../core/types";

export interface StructuredRequest<T> {
  model: string;
  effort: Effort;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** The Claude harness's environment, with any keys saved in Settings > Providers. */
  env?: Record<string, string | undefined>;
}

/** Small one-shot model calls (not agent runs), such as turning plain English into a cron expression. */
export interface LlmGateway {
  readonly configured: boolean;
  structured<T>(request: StructuredRequest<T>): Promise<T>;
}

export class LlmError extends Error {}
