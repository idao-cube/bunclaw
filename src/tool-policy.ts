const PROFILE_TOOLS: Record<string, string[]> = {
  minimal: ["session_status"],
  coding: ["read", "write", "edit", "apply_patch", "exec", "process", "web_search", "web_fetch"],
  full: ["read", "write", "edit", "apply_patch", "exec", "process", "web_search", "web_fetch", "message"],
};

function expand(entries: string[]): string[] {
  const set = new Set<string>();
  for (const e of entries) {
    if (e === "group:fs") ["read", "write", "edit", "apply_patch"].forEach((t) => set.add(t));
    else if (e === "group:runtime") ["exec", "process"].forEach((t) => set.add(t));
    else if (e === "group:web") ["web_search", "web_fetch"].forEach((t) => set.add(t));
    else set.add(e);
  }
  return [...set];
}

export function resolveAllowedTools(input: { profile?: "minimal" | "coding" | "full"; allow?: string[]; deny?: string[] }): Set<string> {
  const profile = input.profile ?? "coding";
  const base = new Set<string>(PROFILE_TOOLS[profile] ?? PROFILE_TOOLS.coding);
  for (const tool of expand(input.allow ?? [])) base.add(tool);
  for (const tool of expand(input.deny ?? [])) base.delete(tool);
  return base;
}


