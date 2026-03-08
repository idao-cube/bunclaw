export class EventLog {
  constructor(private readonly filePath: string) {}

  async append(entry: unknown): Promise<void> {
    await Bun.write(this.filePath, `${JSON.stringify({ ts: new Date().toISOString(), ...((entry ?? {}) as object) })}\n`, { append: true });
  }
}


