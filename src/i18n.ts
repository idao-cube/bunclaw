export function supportsUtf8Console(): boolean {
  const env = process.env;
  const lang = `${env.LANG ?? ""} ${env.LC_ALL ?? ""}`.toLowerCase();
  if (lang.includes("utf-8") || lang.includes("utf8")) return true;
  if (env.WT_SESSION) return true;
  if ((env.TERM_PROGRAM ?? "").toLowerCase().includes("vscode")) return true;
  if ((env.TERM ?? "").toLowerCase().includes("xterm")) return true;
  return false;
}

const ZH = {
  onboard_done: "初始化完成：已创建 bunclaw.json 与本地数据目录。\n控制台地址：http://127.0.0.1:16789/",
  gateway_started: (url: string, web: string) => `网关已启动：${url}（网页控制台：${web}）`,
  unknown_cmd: (cmd: string) => `未知命令: ${cmd}`,
  help: `bunclaw 命令：\n  onboard\n  gateway\n  agent --message \"...\" [--session main]\n  message send --message \"...\" [--session main]\n  doctor\n  clean`,
  clean_done: "清理完成：会话消息、幂等记录与事件日志已清空。",
  doctor_cfg_ok: "已加载 bunclaw.json",
  doctor_sqlite_err: "无法打开 SQLite",
  doctor_gw_ok: "可访问 /health",
  doctor_gw_err: "网关未运行或不可达",
  doctor_model_key_missing: "model.apiKey 为空",
  doctor_pass: (name: string, detail: string) => `通过 ${name}: ${detail}`,
  doctor_fail: (name: string, detail: string) => `失败 ${name}: ${detail}`,
};

const EN = {
  onboard_done: "Initialized bunclaw.json and local data dir.\nConsole: http://127.0.0.1:16789/",
  gateway_started: (url: string, web: string) => `Gateway started: ${url} (Web console: ${web})`,
  unknown_cmd: (cmd: string) => `Unknown command: ${cmd}`,
  help: `bunclaw commands:\n  onboard\n  gateway\n  agent --message \"...\" [--session main]\n  message send --message \"...\" [--session main]\n  doctor\n  clean`,
  clean_done: "Clean complete: sessions/messages/idempotency/events were cleared.",
  doctor_cfg_ok: "bunclaw.json loaded",
  doctor_sqlite_err: "cannot open SQLite",
  doctor_gw_ok: "health endpoint reachable",
  doctor_gw_err: "gateway not running or unreachable",
  doctor_model_key_missing: "model.apiKey missing",
  doctor_pass: (name: string, detail: string) => `PASS ${name}: ${detail}`,
  doctor_fail: (name: string, detail: string) => `FAIL ${name}: ${detail}`,
};

export function msg() {
  return supportsUtf8Console() ? ZH : EN;
}


