import type { AgentAdapter, AgentLaunchRequest, AgentLaunchSpec } from "./types.ts";

export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`agent adapter '${adapter.kind}' is already registered`);
    }
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: string): AgentAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`agent adapter '${kind}' is not registered`);
    return adapter;
  }

  buildLaunchSpec(kind: string, request: AgentLaunchRequest): AgentLaunchSpec {
    return this.get(kind).buildLaunchSpec(request);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()].sort((left, right) => left.kind.localeCompare(right.kind));
  }
}
