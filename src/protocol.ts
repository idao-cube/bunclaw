import type { ConnectFrame, ReqFrame } from "./types";

export function validateFirstFrame(raw: unknown): { ok: true; frame: ConnectFrame } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, reason: "first frame must be object" };
  }
  const frame = raw as Record<string, unknown>;
  if (frame.type !== "connect") {
    return { ok: false, reason: "first frame must be connect" };
  }
  return { ok: true, frame: frame as ConnectFrame };
}

export function validateReqFrame(raw: unknown): { ok: true; frame: ReqFrame } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "invalid frame" };
  const frame = raw as Record<string, unknown>;
  if (frame.type !== "req") return { ok: false, reason: "type must be req" };
  if (typeof frame.id !== "string" || typeof frame.method !== "string") {
    return { ok: false, reason: "id/method must be string" };
  }
  return { ok: true, frame: frame as ReqFrame };
}

