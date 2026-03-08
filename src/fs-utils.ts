export async function writeTextIfChanged(path: string, next: string): Promise<boolean> {
  const file = Bun.file(path);
  if (await file.exists()) {
    const current = await file.text();
    if (current === next) return false;
  }
  await Bun.write(path, next);
  return true;
}

