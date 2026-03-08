export function targetToPlatform(target?: string): "windows" | "linux" | "darwin" | "native" {
  if (!target || target.trim().length === 0) return "native";
  const t = target.toLowerCase();
  if (t.includes("windows")) return "windows";
  if (t.includes("linux")) return "linux";
  if (t.includes("darwin") || t.includes("macos")) return "darwin";
  return "native";
}

export function outputExtension(target?: string): string {
  const p = targetToPlatform(target);
  if (p === "windows") return ".exe";
  if (p === "native") return process.platform === "win32" ? ".exe" : "";
  return "";
}

export function outputLabel(target?: string): string {
  if (target && target.trim().length > 0) return target.trim();
  return `${process.platform}-${process.arch}`;
}

