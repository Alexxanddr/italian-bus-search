import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [artifact] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { encoding: "utf8" }));
const privateFiles = artifact.files.filter(({ path }) => /(?:^|\/)(?:private|fixtures|data|\.env)(?:\/|$)|\.(?:hide|local)\.md$/.test(path));
assert.deepEqual(privateFiles, [], "npm must not contain private notes, fixtures, source data or credentials");
console.log(`${artifact.id}: ${artifact.entryCount} files, no private artifacts`);
