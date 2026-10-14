import { isProviderId, PROVIDERS, type ProviderId } from "../core/providers";
import { AcpRuntime } from "./acp/runtime";
import type { ProviderRegistry } from "./providers";
import type { ChatRuntime } from "./runtime";
import type { ToolBridge } from "./tool-bridge";

/**
 * The harness behind each provider: Claude Code natively, the rest over the
 * Agent Client Protocol. Tests can swap in their own runtime per provider.
 */
export class Runtimes {
  private acp = new Map<ProviderId, ChatRuntime>();

  constructor(
    private claude: ChatRuntime,
    private providers: ProviderRegistry,
    private bridge: ToolBridge,
    private overrides: Partial<Record<ProviderId, ChatRuntime>> = {},
  ) {}

  /** The runtime for a provider id. Chats from before providers existed ran on Claude Code. */
  get(provider: string): ChatRuntime {
    const id: ProviderId = isProviderId(provider) ? provider : "claude-code";
    const override = this.overrides[id];
    if (override) return override;
    if (id === "claude-code") return this.claude;
    let rt = this.acp.get(id);
    if (!rt) {
      rt = new AcpRuntime(id, this.providers, this.bridge);
      this.acp.set(id, rt);
    }
    return rt;
  }

  ids(): ProviderId[] {
    return PROVIDERS.map((p) => p.id);
  }
}
