import { outputExtension, outputLabel } from "./package-lib";

const target = process.env.BUNCLAW_TARGET?.trim();
const ext = outputExtension(target);
const label = outputLabel(target);
const outDir = "dist";
let outFile = `${outDir}/bunclaw-${label}${ext}`;

await ensureDir(outDir);
outFile = await resolveWritableOutput(outFile, ext);

const args = ["bun", "build", "--compile", "bin/bunclaw.ts", "--outfile", outFile];
if (target && target.length > 0) args.push("--target", target);

const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
const code = await proc.exited;
if (code !== 0) {
  console.error(`打包失败，退出码: ${code}`);
  process.exit(code);
}

console.log(`打包完成: ${outFile}`);

async function ensureDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]).exited;
    return;
  }
  await Bun.spawn(["sh", "-lc", `mkdir -p '${dir}'`]).exited;
}

async function resolveWritableOutput(path: string, ext: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return path;
  try {
    await Bun.write(path, "");
    return path;
  } catch {
    const suffix = `${Date.now()}`;
    const base = ext ? path.slice(0, -ext.length) : path;
    return `${base}-${suffix}${ext}`;
  }
}
