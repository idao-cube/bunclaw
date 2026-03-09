export async function backupWorkspace(sourceDir: string, destDir: string): Promise<{ ok: boolean; files: number; dest: string }> {
  if (!sourceDir) throw new Error("sourceDir 不能为空");
  if (!destDir) throw new Error("destDir 不能为空");
  const src = sourceDir.replaceAll("\\", "/").replace(/\/$/, "");
  const dest = destDir.replaceAll("\\", "/").replace(/\/$/, "");

  await ensureDir(dest);

  let count = 0;
  async function copyFile(absSrc: string, rel: string) {
    try {
      const buf = await Bun.file(absSrc).arrayBuffer();
      const outPath = `${dest}/${rel}`;
      const idx = outPath.lastIndexOf("/");
      if (idx > 0) {
        const parent = outPath.slice(0, idx);
        await ensureDir(parent);
      }
      await Bun.write(outPath, new Uint8Array(buf));
      count++;
    } catch {
      // ignore
    }
  }

  // 浅层复制：顶层文件 + 一层子目录文件
  try {
    const topGlob = new Bun.Glob("*");
    for await (const name of topGlob.scan({ cwd: src, onlyFiles: false })) {
      if (!name) continue;
      const abs = `${src}/${name}`;
      const stat = await Bun.file(abs).stat().catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) {
        const subGlob = new Bun.Glob("*");
        for await (const subName of subGlob.scan({ cwd: abs, onlyFiles: false })) {
          if (!subName) continue;
          const subAbs = `${abs}/${subName}`;
          const subStat = await Bun.file(subAbs).stat().catch(() => null);
          if (!subStat || subStat.isDirectory()) continue;
          await copyFile(`${abs}/${subName}`, `${name}/${subName}`);
        }
      } else {
        await copyFile(abs, name);
      }
    }
  } catch {
    // ignore
  }

  return { ok: true, files: count, dest };
}

async function ensureDir(dir: string): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${dir}' -Force | Out-Null`]).exited.catch(() => null);
    return;
  }
  await Bun.spawn(["sh", "-lc", `mkdir -p '${dir}'`]).exited.catch(() => null);
}

export default { backupWorkspace };
