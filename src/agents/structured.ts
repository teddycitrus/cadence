import { z } from "zod";
import type { ProviderRegistry } from "./providers";
import type { ChatRuntime } from "./runtime";
import { hasAnthropicKey } from "./anthropic-llm";
import { LlmError, type LlmGateway, type StructuredRequest } from "./llm";

// One-shot structured answers (like a cron expression from plain English),
// with whatever access this machine has: an Anthropic key saved in Settings >
// Providers or set in the environment goes straight to the API; otherwise the
// default harness answers with its own sign-in (a Claude or ChatGPT
// subscription), and its reply is checked against the same schema.

export interface StructuredDeps {
  llm: LlmGateway;
  providers: ProviderRegistry;
  /** The team's default harness, for machines with a sign-in but no API key. */
  runtime: () => ChatRuntime;
  cwd: string;
}

/** The first JSON object in a reply (harnesses sometimes wrap it in prose or a code fence). */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new LlmError("The reply had no JSON in it.");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LlmError("The reply's JSON could not be read.");
  }
}

export async function structuredAnswer<T>(deps: StructuredDeps, request: StructuredRequest<T>): Promise<T> {
  const env = deps.providers.env("claude-code", request.model);
  if (deps.llm.configured || hasAnthropicKey(env)) return deps.llm.structured({ ...request, env });
  const schema = JSON.stringify(z.toJSONSchema(request.schema));
  const reply = await deps.runtime().complete(`${request.prompt}\n\nAnswer with only one JSON object matching this JSON Schema, and nothing else:\n${schema}`, {
    cwd: deps.cwd,
    model: request.model,
    system: request.system,
  });
  const parsed = request.schema.safeParse(firstJsonObject(reply));
  if (!parsed.success) throw new LlmError("The reply did not match the expected shape.");
  return parsed.data;
}
