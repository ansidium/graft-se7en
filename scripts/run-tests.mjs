/**
 * Runs the test suite without depending on shell glob expansion.
 *
 * `node --test test/*.test.ts` needs the *shell* to expand that glob, and on
 * Windows nothing does: npm runs scripts through `cmd.exe` regardless of the
 * shell that invoked npm, and Node's `--test` only accepts glob patterns itself
 * from Node 21 (this package supports >=20). The literal pattern reaches Node as
 * a filename and it exits with `Could not find '…\test\*.test.ts'` — so the
 * Windows CI leg reported failure while actually running zero tests.
 *
 * Enumerating the files here instead means `npm test` behaves identically in
 * cmd.exe, PowerShell, bash and CI, on any supported Node.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");

// Sorted so a failure is reported in the same order on every platform and run.
const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join(testDir, f));

if (files.length === 0) {
  console.error(`✗ no test files found in ${testDir}`);
  process.exit(1);
}

// Several tests `git init` a scratch repo and `git commit` into it to exercise the
// incremental/submodule/ingest git paths. Those commits inherit the developer's
// global git config — so a contributor who signs commits (gpg, or gitsign, whose
// x509 flow opens a browser for OIDC on EVERY commit) gets a signing storm from a
// run that has nothing to do with their identity. Inject config via GIT_CONFIG_*
// (git merges these over the user's config for this process tree only) so test
// commits never sign, without touching anyone's global settings.
const gitEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
};

// The whole run gets a throwaway home. `graft init` writes outside the repo — hooks
// and a helper under ~/.claude, ~/.claude.json, ~/.codex's hooks.json and
// config.toml — and first retracts every agent it wasn't asked to wire. So a test
// that spawns the CLI, or calls runInit/runRetract, without its own `home` rewired
// the developer's real agents: one run of this suite removed Codex's graft MCP
// server and hooks from ~/.codex. `homedir()` reads HOME on posix and USERPROFILE on
// Windows, so both point here; CLAUDE_CONFIG_DIR would route the Claude writes
// around it, so it is dropped. The scratch home carries its own ~/.gitconfig
// identity — as a file rather than in gitEnv, because GIT_CONFIG_* outranks the
// repo-level identity some tests set and assert on.
const home = mkdtempSync(join(tmpdir(), "graft-test-home-"));
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = graft tests\n\temail = tests@graft.invalid\n");
const env = { ...process.env, ...gitEnv, HOME: home, USERPROFILE: home };
delete env.CLAUDE_CONFIG_DIR;

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], {
  cwd: repoRoot,
  stdio: "inherit",
  env,
});

try {
  rmSync(home, { recursive: true, force: true });
} catch {
  /* a straggler still holding a file there; the OS temp cleaner gets it */
}

if (result.error) {
  console.error(`✗ could not start the test runner: ${result.error.message}`);
  process.exit(1);
}
// A signal-killed run reports null status; treat anything non-zero as failure.
process.exit(result.status ?? 1);
