#!/usr/bin/env node
// R5.1: every query is org-scoped, so Drizzle query builders may only appear in
// packages/db/src/repos/ (whose functions all take orgId). Apps call repo functions.
// Deliberately a regex scan, not an AST parse. Catches `db.select(`, `getDb(env.DB).insert(`, `db.query.x`
// and chained `db\n  .update(`; a renamed handle (const x = db) slips through, which code review covers.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const IGNORE_DIR = new Set(["node_modules", "dist", ".wrangler", "test", "tests", "__tests__"]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
// db / getDb(...) / c.get("db") / this.db, followed by a query builder or the relational query API.
const HANDLE = String.raw`(?:\bdb|\bgetDb\([^)]*\)|\bdbFor\([^)]*\)|c\.get\(["']db["']\))`;
const PATTERN = new RegExp(String.raw`${HANDLE}\s*(?:\.\s*(?:select|selectDistinct|insert|update|delete)\s*\(|\.\s*query\s*\.)`, "g");

function* tsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!IGNORE_DIR.has(e.name)) yield* tsFiles(join(dir, e.name));
    } else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") && !TEST_FILE.test(e.name)) {
      yield join(dir, e.name);
    }
  }
}

const apps = join(root, "apps");
const offenders = [];
for (const app of readdirSync(apps, { withFileTypes: true })) {
  if (!app.isDirectory()) continue;
  let files;
  try {
    files = [...tsFiles(join(apps, app.name, "src"))];
  } catch {
    continue; // app without src/
  }
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(PATTERN)) {
      const line = text.slice(0, m.index).split("\n").length;
      offenders.push(`  ${relative(root, file)}:${line}  ${m[0].replace(/\s+/g, "")}`);
    }
  }
}

if (offenders.length) {
  console.error(`check-scoped-queries: ${offenders.length} Drizzle query(ies) outside packages/db/src/repos/:`);
  console.error(offenders.join("\n"));
  console.error("Move each query into a repo function in packages/db/src/repos/ that takes orgId (R5.1).");
  process.exit(1);
}
console.log("check-scoped-queries: ok (no Drizzle queries in apps/*/src)");
