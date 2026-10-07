#!/usr/bin/env node
/**
 * Count the tests, and hold the README to what it says.
 *
 * The same instrument as framebudget's and glaze's tools/contagem.js, for the
 * same reason: a number typed into prose is a measurement with no instrument
 * behind it, and in the sibling repositories every one of those drifted.
 *
 *   node tools/contagem.js               run the suite and check the README
 *   node tools/contagem.js saida.tap     check against a run that already happened (CI)
 *   node tools/contagem.js --fix         rewrite the README with the real number
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every place the README states the test count. */
const CLAIMS = [
  { file: "README.md", pattern: /tests-(\d+)-brightgreen/ },
  { file: "README.md", pattern: /(\d+) tests, no network/ },
];

const args = process.argv.slice(2);
const fix = args.includes("--fix");
const tapFile = args.find((a) => !a.startsWith("--"));

/**
 * Passing tests from whatever `node --test` printed. Reads both the TAP form
 * ("# pass N") and the spec form ("ℹ pass N"): the count should not depend on
 * which reporter ran, and on Node 24 a misplaced flag silently changes it.
 *
 * @param {string} out
 */
function count(out) {
  const passed = out.match(/^(?:#|ℹ)\s*pass (\d+)$/m);
  if (!passed) {
    console.error('contagem: nao encontrei "pass N" na saida dos testes.');
    process.exit(1);
  }
  const failed = out.match(/^(?:#|ℹ)\s*fail (\d+)$/m);
  if (failed && Number(failed[1]) > 0) {
    console.error(`contagem: ${failed[1]} testes a falhar — corrige isso primeiro.`);
    process.exit(1);
  }
  return Number(passed[1]);
}

function run() {
  const files = readdirSync(join(root, "test"))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => join("test", f));
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: root, encoding: "utf8" });
  return r.stdout + r.stderr;
}

const real = count(tapFile ? readFileSync(tapFile, "utf8") : run());
if (real <= 0) {
  console.error(`contagem: contagem implausivel (${real}).`);
  process.exit(1);
}

let wrong = 0;
for (const { file, pattern } of CLAIMS) {
  const path = join(root, file);
  const text = readFileSync(path, "utf8");
  const m = text.match(pattern);
  if (!m) {
    console.error(`contagem: ${file} deixou de afirmar o numero (${pattern}). Ou se repoe a frase, ou se tira daqui.`);
    wrong++;
    continue;
  }
  if (Number(m[1]) === real) continue;
  if (fix) {
    writeFileSync(path, text.replace(pattern, (whole, n) => whole.replace(n, String(real))));
    console.log(`contagem: ${file}: ${m[1]} -> ${real}`);
  } else {
    console.error(`contagem: ${file} diz ${m[1]}, correram ${real}. node tools/contagem.js --fix`);
    wrong++;
  }
}

if (wrong && !fix) process.exit(1);
if (!wrong) console.log(`contagem: ${real} testes, o README diz o mesmo.`);
