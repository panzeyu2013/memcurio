#!/usr/bin/env bun
/**
 * Compatibility probe: install the packed tarball into an isolated DSH profile
 * for one host version, compose the bundle, boot the web host and assert the
 * mounted surface.
 *
 * Why a separate probe instead of the unit suite: the suite runs against the
 * development host (the newest line) and may use APIs that older hosts do not
 * publish. The contract this package actually claims is the peer range, so the
 * probe exercises the built tarball against the peer floor and one sample per
 * published line: install -> compose -> boot -> route/client. It is
 * intentionally black-box; nothing here imports this repository's sources.
 *
 * Usage:
 *   bun scripts/probe-compat.ts --version 0.2.2-alpha.2
 *   bun scripts/probe-compat.ts --all --clean
 *   bun scripts/probe-compat.ts --version 0.2.1-rc.2 --work /tmp/probe --port 32191
 *   bun scripts/probe-compat.ts --version 0.2.2-alpha.2 --cache .dsh-tmp/warm-bun-cache
 *
 * --work must live under .dsh-tmp or the OS temporary directory: the probe
 * deletes and recreates it, so an unbounded path could erase unrelated files.
 *
 * Requirements: bun (pack + CLI install), node >= 22 (boot; the alpha line
 * needs >= 24.9), pnpm (the profile installer and `dsh plugin add`), curl.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { SUPPORTED_HOSTS } from "./compat-hosts.js";

const repoRoot = resolve(import.meta.dir, "..");

const DEFAULT_PORT = 32_000 + (process.pid % 1000);

interface Options {
  version: string;
  work: string;
  port: number;
  clean: boolean;
  all: boolean;
  /** Optional warm bun cache for local runs; CI leaves it empty (project cache). */
  cache: string;
  /** True when --port was passed, so a busy port is an error instead of a scan. */
  portExplicit: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let version = "";
  let work = "";
  let port = DEFAULT_PORT;
  let clean = false;
  let all = false;
  let cache = "";
  let portExplicit = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version") version = argv[++i] ?? "";
    else if (arg === "--work") work = argv[++i] ?? "";
    else if (arg === "--port") {
      port = Number(argv[++i] ?? DEFAULT_PORT);
      portExplicit = true;
    }
    else if (arg === "--cache") cache = argv[++i] ?? "";
    else if (arg === "--all") all = true;
    else if (arg === "--clean") clean = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("--port must be a TCP port");
  if (all && version !== "") throw new Error("--all and --version are mutually exclusive");
  if (!all && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("--version <dsh-version> is required (for example 0.2.2-alpha.2), or use --all");
  }
  const base = work === "" ? join(repoRoot, ".dsh-tmp", "probe-compat") : resolve(work);
  return {
    version,
    // --all nests one directory per version under the base; a single probe
    // treats --work as its exact directory.
    work: all ? base : work === "" ? join(base, version) : base,
    port,
    clean,
    all,
    cache: cache === "" ? "" : resolve(cache),
    portExplicit,
  };
}

/** The probe deletes its work directory; never let it point outside scratch space. */
function assertProbeWorkPath(work: string): void {
  const scratchRoots = [join(repoRoot, ".dsh-tmp") + sep, resolve(tmpdir()) + sep];
  if (!scratchRoots.some((root) => work.startsWith(root))) {
    throw new Error(`--work must live under .dsh-tmp or ${tmpdir()}: ${work}`);
  }
}

function which(name: string): string {
  const found = Bun.which(name);
  if (found === null) throw new Error(`required executable not found on PATH: ${name}`);
  return found;
}

function tail(text: string, lines = 40): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

interface RunOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Stream child output to the console (long installs) instead of capturing it. */
  stream?: boolean;
}

function run(command: string, args: readonly string[], options: RunOptions): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
    // A pipe on stdin that never closes blocks CLIs that probe for a TTY or
    // read a confirmation; every probe command must see EOF instead.
    stdio: options.stream === true ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) {
    throw new Error(`command failed (${command} ${args.join(" ")}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `command failed (exit ${String(result.status)}): ${command} ${args.join(" ")}\n${tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

/**
 * Run a package install, retrying once on the transient EAGAIN that pnpm's
 * import stage reports on overlay filesystems when many files are copied
 * concurrently. The retry reuses the store the first attempt populated, so it
 * is cheap; a semantic failure (exit 1, missing package) still fails the probe.
 */
function install(command: string, args: readonly string[], options: RunOptions): string {
  try {
    return run(command, args, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("EAGAIN")) throw error;
    console.warn("   transient EAGAIN during the package import; retrying once");
    return run(command, args, options);
  }
}

function step(label: string): void {
  console.log(`== ${label} (${new Date().toISOString()})`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(read: () => string, predicate: (text: string) => boolean, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = read();
    if (predicate(text)) return text;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the host\n${tail(read())}`);
}

function http(port: number, path: string, extra: readonly string[] = [], output = "/dev/null"): string {
  const args = ["-s", "-m", "10", "-o", output, "-w", "%{http_code}", ...extra, `http://127.0.0.1:${port}${path}`];
  const result = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error !== undefined) throw result.error;
  return (result.stdout ?? "").trim();
}

/** Whether anything still accepts TCP connections on the port. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (listening: boolean): void => {
      socket.destroy();
      resolvePromise(listening);
    };
    socket.setTimeout(500, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function waitForPortClosed(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isListening(port))) return true;
    await sleep(250);
  }
  return !(await isListening(port));
}

function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

/** Pick a free port; an explicit --port must be free, a derived one may scan. */
async function freePort(start: number, explicit: boolean): Promise<number> {
  if (await portAvailable(start)) return start;
  if (explicit) throw new Error(`--port ${start} is already in use`);
  for (let port = start + 1; port < start + 50 && port <= 65_535; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`no free port in [${start}, ${start + 50})`);
}

async function probeVersion(options: Options): Promise<void> {
  const bun = process.execPath;
  const node = which("node");
  if (Bun.which("pnpm") === null) {
    throw new Error("required executable not found on PATH: pnpm (the plugin gate forwards to it)");
  }
  if (Bun.which("curl") === null) throw new Error("required executable not found on PATH: curl");

  assertProbeWorkPath(options.work);
  const cliDir = join(options.work, "cli");
  const home = join(options.work, "home");
  const packDir = join(options.work, "pack");
  const jar = join(options.work, "cookies.txt");
  const bootLog = join(options.work, "boot.log");
  const xdgData = join(options.work, "xdg", "data");
  const xdgState = join(options.work, "xdg", "state");
  const pnpmStore = join(options.work, "pnpm-store");
  const env: Record<string, string | undefined> = {
    ...process.env,
    DSH_HOME: home,
    // Only the pnpm store is redirected. XDG_CACHE_HOME is deliberately left
    // alone: overriding it gives bun a cold install cache and re-downloads the
    // whole host tree on every probe. Bun's cache stays project-local unless
    // --cache supplies a warm directory; --all runs sequentially, so a shared
    // cache is safe there while concurrent probes would contend on its lock.
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    npm_config_store_dir: pnpmStore,
    ...(options.cache === "" ? {} : { BUN_INSTALL_CACHE_DIR: options.cache }),
    CI: "1",
  };

  step(`probe dsh ${options.version} (${options.work})`);
  rmSync(options.work, { recursive: true, force: true });
  for (const dir of [cliDir, home, packDir, xdgData, xdgState, pnpmStore]) {
    mkdirSync(dir, { recursive: true });
  }
  await Bun.write(join(cliDir, "package.json"), `${JSON.stringify({ name: "memcurio-compat-probe", private: true }, null, 2)}\n`);

  step("install the host CLI");
  run(bun, ["add", `@deepseek-ai/dsh@${options.version}`], { cwd: cliDir, env, stream: true });
  const dshBin = join(cliDir, "node_modules", ".bin", "dsh");

  step("create the isolated profile");
  // Materialize the shipped web template and exit. Without --dump-config the
  // CLI boots the host and blocks, which is not what a probe wants.
  run(node, [dshBin, "--profile", "probe", "--from-default-profile", "web", "--dump-config"], { cwd: cliDir, env });
  const profileDir = join(home, "profiles", "probe");
  assert(existsSync(join(profileDir, "package.json")), `profile skeleton missing at ${profileDir}`);

  step("pack this package");
  run(bun, ["pm", "pack", "--ignore-scripts", "--destination", packDir], { cwd: repoRoot, env: { ...process.env } });
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert(tarballs.length === 1, `expected one tarball in ${packDir}, found: ${tarballs.join(", ")}`);
  const tarball = join(packDir, tarballs[0] as string);

  step("install the tarball through the plugin gate");
  // The store and the profile live under the same work directory, so hardlink
  // import is both valid and deterministic; the default auto chain falls back
  // to copyfile under this sandbox and intermittently fails with EAGAIN.
  install(
    node,
    [
      dshBin,
      "plugin",
      "--profile",
      "probe",
      "add",
      `file:${tarball}`,
      "--config.minimum-release-age=0",
      "--config.package-import-method=hardlink",
    ],
    { cwd: cliDir, env },
  );
  const profileManifest = JSON.parse(readFileSync(join(profileDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  assert(profileManifest.dependencies?.["@memcurio/dsh-plugin"] !== undefined, "profile package.json has no @memcurio/dsh-plugin dependency");
  assert(
    profileManifest.dsh?.profile?.bundles?.includes("@memcurio/dsh-plugin") === true,
    "profile bundles did not adopt @memcurio/dsh-plugin",
  );

  // Install the host bundles only after the gate. Against an empty skeleton the
  // gate is instant and deterministic; against a fully installed web profile it
  // ran for minutes without output (observed with 0.2.2-alpha.2), so the probe
  // deliberately gates first. The final profile state is identical either way
  // because the installer resolves the profile's package.json, which the gate
  // updates.
  //
  // The gate is the installer under test and runs through `dsh plugin add`
  // (pnpm). Bulk host materialization uses bun: pnpm's hoisted import copies
  // hundreds of files and intermittently fails with EAGAIN on overlay
  // filesystems, while bun's flat tree is both fast and node-resolvable. This
  // does not weaken the boot/route claim: the plugin is still installed and
  // validated by the real pnpm gate above.
  step("install the host bundles");
  install(
    bun,
    [
      "add",
      `@deepseek-ai/dsh-base@${options.version}`,
      `@deepseek-ai/dsh-web-app@${options.version}`,
      "--ignore-scripts",
    ],
    { cwd: profileDir, env, stream: true },
  );

  step("compose the profile");
  const composed = run(node, [dshBin, "--profile", "probe", "--dump-config"], { cwd: cliDir, env });
  assert(composed.includes("id: memcurio"), "composed tree has no memcurio row");
  assert(composed.includes("@memcurio/dsh-plugin"), "composed tree lost the package name");
  if (options.version.startsWith("0.2.2")) {
    assert(composed.includes("id: tool-executor-native"), "0.2.2 host composition has no native tool executor");
  }

  const port = await freePort(options.port, options.portExplicit);
  step(`boot the web host on 127.0.0.1:${port}`);
  const child = spawn(node, [dshBin, "--profile", "probe", "--port", String(port), "--no-open"], {
    cwd: cliDir,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const readLog = (): string => `${stdout}\n${stderr}`;
  let leakedPort = false;
  try {
    const log = await waitFor(readLog, (text) => /\?token=[A-Za-z0-9_-]+/.test(text), 90_000);
    const token = /\?token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? "";
    assert(token !== "", "boot log carried no token");
    const indexHtml = join(options.work, "index.html");
    const root = http(port, `/?token=${token}`, ["-c", jar, "-b", jar, "-L"], indexHtml);
    assert(root === "200", `web root answered ${root}, expected 200`);
    const html = readFileSync(indexHtml, "utf8");
    assert(html.includes("@memcurio/dsh-plugin/client.js"), "boot payload does not register @memcurio/dsh-plugin/client.js");

    // A 403 alone cannot prove the token check ran: the transport rejects
    // before dispatch, so an always-403 handler would also pass. Prove the
    // handler's own contract: the forbidden body, the HEAD method guard, and a
    // VALID plugin token reaching the snapshot dispatcher (unknown session ->
    // 404 unknown-session).
    const uiToken = /__MEMCURIO_UI__[^\n]{0,200}?"token":"([0-9a-f]{16,})"/.exec(html)?.[1];
    assert(uiToken !== undefined, "index.html carries no __MEMCURIO_UI__ token");
    const forbiddenBody = join(options.work, "forbidden.json");
    const forbidden = http(port, "/memcurio/snapshot?session=probe", ["-H", "x-memcurio-token: bogus"], forbiddenBody);
    assert(forbidden === "403", `/memcurio/snapshot answered ${forbidden}, expected 403 (token rejected)`);
    assert(readFileSync(forbiddenBody, "utf8").includes("forbidden"), "403 body is not the plugin's forbidden response");
    const head = http(port, "/memcurio/snapshot", ["-I"]);
    assert(head === "405", `HEAD /memcurio/snapshot answered ${head}, expected 405 (the plugin handler's method guard)`);
    const snapshotBody = join(options.work, "snapshot.json");
    const snapshot = http(port, "/memcurio/snapshot?session=probe", ["-H", `x-memcurio-token: ${uiToken}`], snapshotBody);
    assert(snapshot === "404", `valid-token snapshot answered ${snapshot}, expected 404 (unknown-session)`);
    assert(readFileSync(snapshotBody, "utf8").includes("unknown-session"), "valid-token snapshot is not the unknown-session 404");

    // Registration alone does not prove the bundle is served: fetch the
    // revisioned plugin bundle from the boot payload and check its content.
    const href = /href="(plugins\/\?\?[^"]*@memcurio\/dsh-plugin\/client\.js[^"]*)"/.exec(html)?.[1];
    assert(href !== undefined, "index.html carries no client bundle link");
    const bundleFile = join(options.work, "client-bundle.js");
    const bundleStatus = http(port, `/${href.replaceAll("&amp;", "&")}`, ["-b", jar], bundleFile);
    assert(bundleStatus === "200", `client bundle answered ${bundleStatus}, expected 200`);
    assert(readFileSync(bundleFile, "utf8").includes("memory_cite"), "client bundle does not contain the memcurio client code");

    const unknown = http(port, "/memcurio-nope");
    assert(unknown === "404", `unknown route answered ${unknown}, expected 404`);
    console.log(`   root=${root} forbidden=${forbidden} head=${head} snapshot=${snapshot} bundle=${bundleStatus} unknown=${unknown}`);
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await sleep(1500);
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    // A probe must not leave a listener behind: --all would pick another port
    // and mask the leak, and CI reuses machines across jobs. A cleanup failure
    // on an otherwise successful probe is a hard failure; a probe that already
    // failed keeps its original error and the listener is reported by the
    // caller's log.
    leakedPort = !(await waitForPortClosed(port, 10_000));
    await Bun.write(bootLog, readLog());
  }
  assert(!leakedPort, `127.0.0.1:${port} still accepts connections after SIGKILL`);

  const summary = {
    ok: true,
    version: options.version,
    port,
    ...(options.clean ? { cleaned: true } : { tarball, profileDir, bootLog }),
  };
  if (options.clean) {
    rmSync(options.work, { recursive: true, force: true });
  }
  console.log(JSON.stringify(summary, null, 2));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.all) {
    for (const version of SUPPORTED_HOSTS) {
      await probeVersion({ ...options, version, work: join(options.work, version) });
    }
    return;
  }
  await probeVersion(options);
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
