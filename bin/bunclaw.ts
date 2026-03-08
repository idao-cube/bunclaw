#!/usr/bin/env bun
import { defaultConfig, ensureDataDirs, loadConfig, saveConfig } from "../src/config";
import { callGateway } from "../src/client";
import { startGateway } from "../src/gateway";
import { DatabaseStore } from "../src/db";
import { msg } from "../src/i18n";

async function main() {
  const t = msg();
  const [, , cmd, ...rest] = process.argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    printHelp(t.help);
    return;
  }

  if (cmd === "onboard") {
    const cfg = defaultConfig();
    await saveConfig(cfg);
    await ensureDataDirs(cfg);
    console.log(t.onboard_done);
    return;
  }

  if (cmd === "gateway") {
    const server = await startGateway();
    console.log(t.gateway_started(`ws://${server.hostname}:${server.port}/ws`, `http://${server.hostname}:${server.port}/`));
    return;
  }

  if (cmd === "agent") {
    const message = readFlag(rest, "--message") ?? "";
    const sessionKey = readFlag(rest, "--session") ?? "main";
    const idemKey = readFlag(rest, "--idem") ?? crypto.randomUUID();
    const { response, events } = await callGateway("agent.run", { sessionKey, message }, { idemKey, watchEvents: true });
    for (const e of events) {
      if (e.event === "agent.delta") process.stdout.write(String((e.payload as any).text ?? ""));
    }
    if (events.some((e) => e.event === "agent.delta")) process.stdout.write("\n");
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  if (cmd === "message" && rest[0] === "send") {
    const sessionKey = readFlag(rest, "--session") ?? "main";
    const message = readFlag(rest, "--message") ?? "";
    const idemKey = readFlag(rest, "--idem") ?? crypto.randomUUID();
    const { response } = await callGateway("message.send", { sessionKey, message }, { idemKey });
    console.log(JSON.stringify(response, null, 2));
    return;
  }

  if (cmd === "doctor") {
    const cfg = await loadConfig();
    const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
    checks.push({ check: "config", ok: true, detail: t.doctor_cfg_ok });
    const dbOk = (() => {
      try {
        const db = new DatabaseStore(cfg.sessions.dbPath);
        db.listSessions();
        return true;
      } catch {
        return false;
      }
    })();
    checks.push({ check: "sqlite", ok: dbOk, detail: dbOk ? cfg.sessions.dbPath : t.doctor_sqlite_err });

    const gatewayOk = await checkGateway(cfg.gateway.host, cfg.gateway.port);
    checks.push({ check: "gateway", ok: gatewayOk, detail: gatewayOk ? t.doctor_gw_ok : t.doctor_gw_err });

    const modelOk = await checkModel(cfg.model.baseUrl, cfg.model.apiKey);
    checks.push({ check: "model_api", ok: modelOk.ok, detail: modelOk.detail });

    for (const item of checks) {
      console.log(item.ok ? t.doctor_pass(item.check, item.detail) : t.doctor_fail(item.check, item.detail));
    }
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
    return;
  }

  if (cmd === "clean") {
    const cfg = await loadConfig();
    const db = new DatabaseStore(cfg.sessions.dbPath);
    db.clearChatData();
    await Bun.write(cfg.sessions.eventsPath, "");
    console.log(t.clean_done);
    return;
  }

  console.error(t.unknown_cmd(cmd));
  printHelp(t.help);
  process.exitCode = 1;
}

function printHelp(helpText: string) {
  console.log(helpText);
}

function readFlag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return null;
  return args[i + 1];
}

async function checkGateway(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function checkModel(baseUrl: string, apiKey: string): Promise<{ ok: boolean; detail: string }> {
  const t = msg();
  if (!apiKey) return { ok: false, detail: t.doctor_model_key_missing };
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    return { ok: res.ok, detail: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

await main();


