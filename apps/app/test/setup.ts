import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      DB: D1Database;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      TEST_ACCESS_PRIVATE_JWK: string;
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
