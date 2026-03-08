const targets = [
  "bun-windows-x64",
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-x64",
  "bun-darwin-arm64",
];

for (const target of targets) {
  console.log(`开始打包目标: ${target}`);
  const proc = Bun.spawn(["bun", "run", "scripts/package.ts"], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, BUNCLAW_TARGET: target },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`目标 ${target} 打包失败，停止。`);
    process.exit(code);
  }
}

console.log("全部目标打包完成。");

