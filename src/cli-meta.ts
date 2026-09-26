/**
 * `graft version` / `graft --version` / `graft upgrade` support.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath } from "./util/paths.js";

const PKG_NAME = "@nanonets/graft";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** True when the running module lives under an npx cache dir (e.g.
 * `~/.npm/_npx/<hash>/node_modules/...`) rather than a regular global install.
 *
 * Normalized first: `fileURLToPath` returns the *platform* separator, so on
 * Windows the cache path is `…\_npx\…` and a bare `includes("/_npx/")` is always
 * false — `graft upgrade` would then run `npm install -g` on top of an npx run.
 * Same hardcoded-`/` mistake as #33; `src/util/paths.ts` exists for exactly this. */
export function isRunningViaNpx(moduleUrl: string): boolean {
  return toPosixPath(fileURLToPath(moduleUrl)).includes("/_npx/");
}

export interface NpmInvocation {
  command: string;
  args: string[];
  shell: boolean;
}

/** How to launch `npm <args>` on `platform`.
 *
 * On Windows `npm` is a `.cmd` shim that only a shell can start: spawned
 * directly it fails with ENOENT, so `graft version` always read "unreachable",
 * the background update check never stored an answer, and `graft upgrade`
 * could not run. The shell gets one pre-joined command line rather than an args
 * array, because Node 24 warns (DEP0190) whenever it has to concatenate args
 * for a shell itself. Every arg passed here is a fixed token, never user input. */
export function npmInvocation(args: readonly string[], platform: NodeJS.Platform = process.platform): NpmInvocation {
  if (platform === "win32") return { command: ["npm", ...args].join(" "), args: [], shell: true };
  return { command: "npm", args: [...args], shell: false };
}

function npmSync(args: readonly string[], options: SpawnSyncOptions) {
  const inv = npmInvocation(args);
  return spawnSync(inv.command, inv.args, { ...options, shell: inv.shell });
}

export interface NpmViewResult {
  ok: boolean;
  version?: string;
}

/** `npm view <pkg> version`, offline-safe: any failure (no npm, no network,
 * timeout) resolves to `{ ok: false }` rather than throwing. */
export function getNpmViewVersion(pkgName: string = PKG_NAME, timeoutMs = 2000): NpmViewResult {
  try {
    const res = npmSync(["view", pkgName, "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (res.error || res.signal || res.status !== 0) return { ok: false };
    const version = res.stdout?.toString().trim();
    if (!version) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

/** Pure formatter for `graft version` — no I/O, easy to unit-test. */
export function formatVersionReport(current: string, latest: NpmViewResult): string {
  const lines = [`graft ${current}`];
  if (!latest.ok || !latest.version) {
    lines.push("latest: unreachable (offline?)");
  } else if (latest.version === current) {
    lines.push(`latest on npm: ${current} ✓ up to date`);
  } else {
    lines.push(`latest on npm: ${latest.version} — run graft upgrade`);
  }
  return lines.join("\n");
}

/** The global npm node_modules dir (handles Homebrew/Windows/volta layouts). */
function globalRoot(): string | null {
  try {
    const res = npmSync(["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if (res.error || res.status !== 0) return null;
    return res.stdout?.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Reads the version actually sitting in the global install, straight from
 * disk — more reliable right after `npm install -g` than re-querying the
 * registry (which just tells you what "latest" is, not what landed locally). */
export function readGlobalInstalledVersion(pkgName: string = PKG_NAME): string | null {
  const root = globalRoot();
  if (!root) return null;
  const pkgJson = join(root, ...pkgName.split("/"), "package.json");
  if (!existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface UpgradeResult {
  /** True when `npm install -g` actually ran (false for the npx no-op path). */
  ran: boolean;
  ok: boolean;
  /** Present when ran=true and the install failed. */
  errorMessage?: string;
  oldVersion?: string;
  newVersion?: string;
}

/** Pure formatter for a finished upgrade — no I/O, easy to unit-test. */
export function formatUpgradeReport(result: UpgradeResult): string {
  if (!result.ran) {
    return (
      "running via npx — npx already fetches the latest graft on every run.\n" +
      "For a permanent install: npm install -g github:ansidium/graft-se7en"
    );
  }
  if (!result.ok) {
    return `✗ npm install -g github:ansidium/graft-se7en failed${result.errorMessage ? `: ${result.errorMessage}` : ""}`;
  }
  return `graft ${result.oldVersion ?? "?"} → ${result.newVersion ?? result.oldVersion ?? "?"}`;
}

/** Runs `npm install -g github:ansidium/graft-se7en` (inheriting stdio so the user
 * sees npm's own progress/errors), then re-reads the freshly installed
 * version. No-ops with guidance when running via npx. */
export function runUpgrade(moduleUrl: string): UpgradeResult {
  const oldVersion = readCurrentVersion(moduleUrl);
  if (isRunningViaNpx(moduleUrl)) {
    return { ran: false, ok: true, oldVersion };
  }
  const res = npmSync(["install", "-g", "github:ansidium/graft-se7en"], { stdio: "inherit" });
  if (res.error || (res.status ?? 1) !== 0) {
    return { ran: true, ok: false, oldVersion, errorMessage: res.error?.message };
  }
  const newVersion = readGlobalInstalledVersion("graft-se7en") ?? readGlobalInstalledVersion(PKG_NAME) ?? oldVersion;
  return { ran: true, ok: true, oldVersion, newVersion };
}
