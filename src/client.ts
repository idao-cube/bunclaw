import { loadConfig } from "./config";
import type { EventFrame, ResFrame } from "./types";

export async function callGateway(
  method: string,
  params: Record<string, unknown>,
  options?: { idemKey?: string; watchEvents?: boolean; configPath?: string },
): Promise<{ response: ResFrame; events: EventFrame[] }> {
  const config = await loadConfig(options?.configPath);
  const url = `ws://${config.gateway.host}:${config.gateway.port}/ws`;

  return await new Promise((resolve, reject) => {
    const events: EventFrame[] = [];
    const ws = new WebSocket(url);
    const reqId = crypto.randomUUID();

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "connect", auth: { token: config.gateway.token || "" }, client: "bunclaw-cli" }));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as any;
      if (msg.type === "res" && msg.id === "connect") {
        ws.send(JSON.stringify({ type: "req", id: reqId, method, params, ...(options?.idemKey ? { idemKey: options.idemKey } : {}) }));
        return;
      }
      if (msg.type === "event") {
        events.push(msg as EventFrame);
        return;
      }
      if (msg.type === "res" && msg.id === reqId) {
        const response = msg as ResFrame;
        if (!options?.watchEvents) {
          ws.close();
          resolve({ response, events });
          return;
        }
        setTimeout(() => {
          ws.close();
          resolve({ response, events });
        }, 300);
      }
    };

    ws.onerror = () => reject(new Error("网关 WebSocket 连接失败"));
  });
}


