import { Container, getContainer } from "@cloudflare/containers";
import type { Env } from "./env";

/** ClamAV + HTTP shim (containers/clamav). Contract: POST /scan → {result: "clean"|"infected"|"error", signature?}. */
export class ClamAvContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
}

export type ScanResult = { result: "clean" | "infected"; signature?: string };
export type Scanner = (bytes: Uint8Array) => Promise<ScanResult>;

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/**
 * Throws when the scanner is unreachable so the queue retries and the file stays in quarantine (R10.5).
 * Local development without Docker uses a stand-in that only detects the EICAR test string.
 */
export function scannerFor(env: Env): Scanner {
  // Local dev runs with containers disabled unless SCANNER=container.
  if (!env.CLAMAV || (env.APP_ENV === "local" && env.SCANNER !== "container")) {
    if (env.APP_ENV !== "local" && env.APP_ENV !== "test") throw new Error("CLAMAV binding missing");
    return async (bytes) => (new TextDecoder().decode(bytes).includes(EICAR) ? { result: "infected", signature: "Eicar-Test-Signature" } : { result: "clean" });
  }
  const ns = env.CLAMAV;
  return async (bytes) => {
    // Two instances (max_instances = 2); spread load by a random pick.
    const stub = getContainer(ns, `scanner-${Math.floor(Math.random() * 2)}`);
    const res = await stub.fetch(new Request("http://clamav/scan", { method: "POST", body: bytes }));
    const j = (await res.json().catch(() => ({ result: "error" }))) as { result: string; signature?: string; message?: string };
    if (!res.ok || (j.result !== "clean" && j.result !== "infected")) throw new Error(`Scanner unavailable: ${res.status} ${j.message ?? ""}`);
    return { result: j.result, signature: j.signature };
  };
}
export { EICAR };
