import { describe, expect, test } from "bun:test";
import { ProcessManager } from "../src/process-manager";

describe("process manager", () => {
  test("start list poll kill", async () => {
    const pm = new ProcessManager();
    const info = pm.start(process.platform === "win32" ? "Start-Sleep -Seconds 5" : "sleep 5");
    const list = pm.list();
    expect(list.some((item) => item.id === info.id)).toBe(true);

    const polled = pm.poll(info.id);
    expect(polled?.status).toBe("running");

    const killed = pm.kill(info.id);
    expect(killed).toBe(true);
  });
});


