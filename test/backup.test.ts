import { backupWorkspace } from "../src/maintenance";
import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { test, expect, afterAll } from "bun:test";

const srcDir = "temp/.tmp-backup-src";
const destDir = "temp/.tmp-backup-dest";

// 创建源目录和文件

async function setupSource() {
  if (process.platform === "win32") {
    Bun.spawnSync(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${srcDir}' -Force | Out-Null`]);
    await Bun.write(join(srcDir, "a.txt"), "hello");
    await Bun.write(join(srcDir, "b.txt"), "world");
    Bun.spawnSync(["powershell", "-NoProfile", "-Command", `New-Item -ItemType Directory -Path '${join(srcDir, "subdir")}' -Force | Out-Null`]);
    await Bun.write(join(srcDir, "subdir", "c.txt"), "sub");
  } else {
    Bun.spawnSync(["mkdir", "-p", srcDir]);
    await Bun.write(join(srcDir, "a.txt"), "hello");
    await Bun.write(join(srcDir, "b.txt"), "world");
    Bun.spawnSync(["mkdir", "-p", join(srcDir, "subdir")]);
    await Bun.write(join(srcDir, "subdir", "c.txt"), "sub");
  }
}

function cleanup() {
  if (process.platform === "win32") {
    Bun.spawnSync(["powershell", "-NoProfile", "-Command", `Remove-Item -Path '${srcDir}' -Recurse -Force -ErrorAction SilentlyContinue`]);
    Bun.spawnSync(["powershell", "-NoProfile", "-Command", `Remove-Item -Path '${destDir}' -Recurse -Force -ErrorAction SilentlyContinue`]);
  } else {
    Bun.spawnSync(["rm", "-rf", srcDir]);
    Bun.spawnSync(["rm", "-rf", destDir]);
  }
}

afterAll(cleanup);

test("backupWorkspace copies files shallowly", async () => {
  cleanup();
  await setupSource();
  // 等待文件写入完成
  await new Promise(r => setTimeout(r, 200));
  const res = await backupWorkspace(srcDir, destDir);
  expect(res.ok).toBe(true);
  expect(res.files).toBeGreaterThanOrEqual(3);
  // 顶层文件
  expect(existsSync(join(destDir, "a.txt"))).toBe(true);
  expect(readFileSync(join(destDir, "a.txt"), "utf8")).toBe("hello");
  expect(existsSync(join(destDir, "b.txt"))).toBe(true);
  // 子目录文件
  expect(existsSync(join(destDir, "subdir", "c.txt"))).toBe(true);
  expect(readFileSync(join(destDir, "subdir", "c.txt"), "utf8")).toBe("sub");
});
