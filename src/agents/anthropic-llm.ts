import type Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LlmError, type LlmGateway, type StructuredRequest } from "./llm";

// Server-side refusal fallback: on a policy decline the API reruns the request
// on a fallback model chosen by refusal category.
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

function hasCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE) return true;
  return existsSync(join(homedir(), ".config", "anthropic"));
}

/** Whether an environment (a harness's, with keys from Settings > Providers) holds an Anthropic key or token. */
export function hasAnthropicKey(env: Record<string, string | undefined>): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

export class AnthropicLlm implements LlmGateway {
  /** Credentials in this server's own environment or Anthropic's config file. Keys saved in Cadence come with each request. */
  readonly configured = hasCredentials();
  private clients = new Map<string, Anthropic>();

  async structured<T>(request: StructuredRequest<T>): Promise<T> {
    const env = request.env ?? {};
    if (!this.configured && !hasAnthropicKey(env)) throw new LlmError("No Anthropic API key. Add one in Settings > Providers, or sign in to Claude there.");
    // The SDK loads on the first call; most sessions never make one.
    const [{ default: AnthropicClient }, { betaZodOutputFormat }] = await Promise.all([import("@anthropic-ai/sdk"), import("@anthropic-ai/sdk/helpers/beta/zod")]);
    // One client per key and base URL: a key saved in Settings wins over the server's environment.
    const options = { apiKey: env.ANTHROPIC_API_KEY ?? null, authToken: env.ANTHROPIC_AUTH_TOKEN ?? null, baseURL: env.ANTHROPIC_BASE_URL ?? null };
    const key = JSON.stringify(options);
    let client = this.clients.get(key);
    if (!client) {
      client = hasAnthropicKey(env) ? new AnthropicClient({ apiKey: options.apiKey, authToken: options.authToken, ...(options.baseURL ? { baseURL: options.baseURL } : {}) }) : new AnthropicClient();
      this.clients.set(key, client);
    }
    const response = await client.beta.messages.parse({
      model: request.model,
      max_tokens: 4000,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      output_config: { effort: request.effort, format: betaZodOutputFormat(request.schema) },
    });
    if (response.stop_reason === "refusal") throw new LlmError("The model declined this request.");
    if (response.parsed_output === null || response.parsed_output === undefined) throw new LlmError("The model response did not match the expected schema.");
    return response.parsed_output as T;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof LlmError) return err.message;
  // The SDK's error classes carry the HTTP status; matched by it so the SDK need not load just to describe one.
  const status = err instanceof Error && typeof (err as { status?: unknown }).status === "number" ? (err as Error & { status: number }).status : null;
  if (status === 401) return "Anthropic rejected the credentials (401).";
  if (status === 429) return "Rate limited by the Anthropic API (429). Try again shortly.";
  if (status !== null) return `Anthropic API error ${status}: ${(err as Error).message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
