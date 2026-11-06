#!/usr/bin/env node
// R20.2: migrations must stay backward compatible with the previous Worker version.
// Destructive statements need an explicit `-- breaking-approved` line in the file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "migrations");
const BREAKING = /\b(DROP\s+TABLE|DROP\s+COLUMN|RENAME)\b/gi;
const APPROVED = /^\s*--\s*breaking-approved\s*$/im;

const failures = [];
for (const name of readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  const sql = readFileSync(join(dir, name), "utf8");
  if (APPROVED.test(sql)) continue;
  // Ignore comments so a note like "-- we never DROP TABLE here" doesn't trip the check.
  const code = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of code.matchAll(BREAKING)) {
    const line = code.slice(0, m.index).split("\n").length;
    failures.push(`  migrations/${name}:${line}  ${m[0].toUpperCase().replace(/\s+/g, " ")}`);
  }
}

if (failures.length) {
  console.error("check-migrations: backward-incompatible statements found:");
  console.error(failures.join("\n"));
  console.error("Make the change additive (add column, backfill, drop in a later release), or add a line `-- breaking-approved` to the file (R20.2).");
  process.exit(1);
}
console.log("check-migrations: ok");
