import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Workstream W0: resolve how a watched repository expects to be installed,
 * migrated, seeded, built, tested, and run — without executing its code.
 *
 * Tier 1: `.aikya/preview.yml` (or `.yaml` / `.json`) declares the contract.
 * Tier 2: infer from package.json, lockfiles, Drizzle config, and .env.example.
 * Tier 3: fail closed; never invent a command for a repository we cannot read.
 */
export const MANIFEST_PATHS = [
  ".aikya/preview.yml",
  ".aikya/preview.yaml",
  ".aikya/preview.json",
] as const;

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";
export type Runtime = "bun" | "node";
export type DatabaseProvider = "neon" | "postgres";
export type ContractSource = "manifest" | "detected";

export interface PreviewApp {
  command: string;
  port: number;
}

export interface PreviewContract {
  version: 1;
  source: ContractSource;
  /** Absolute path the contract was resolved from. */
  root: string;
  /** Manifest path relative to `root`, or null when detected. */
  manifestPath: string | null;
  runtime: Runtime;
  packageManager: PackageManager | null;
  install: string | null;
  migrate: string | null;
  seed: string | null;
  build: string | null;
  test: string | null;
  app: PreviewApp | null;
  /** Environment variable **names** the run needs; values come from the control plane. */
  envRequired: string[];
  migrationsDir: string | null;
  database: {
    required: boolean;
    provider: DatabaseProvider | null;
  };
  /** Non-fatal problems and inferences worth showing in the check output. */
  warnings: string[];
}

export class PreviewContractError extends Error {
  constructor(
    message: string,
    readonly root: string,
    readonly manifestPath?: string,
  ) {
    super(message);
    this.name = "PreviewContractError";
  }
}

type CommandName = "install" | "migrate" | "seed" | "build" | "test";

const COMMAND_NAMES: readonly CommandName[] = [
  "install",
  "migrate",
  "seed",
  "build",
  "test",
];

const PACKAGE_MANAGERS: readonly PackageManager[] = ["bun", "npm", "pnpm", "yarn"];

const MANIFEST_KEYS = new Set([
  "version",
  "runtime",
  "packageManager",
  "database",
  "commands",
  "app",
  "env",
  "migrations",
]);

type JsonObject = Record<string, unknown>;

interface Manifest {
  runtime: Runtime | null;
  packageManager: PackageManager | null;
  databaseRequired: boolean | null;
  databaseProvider: DatabaseProvider | null;
  commands: Partial<Record<CommandName, string>>;
  app: PreviewApp | null;
  envRequired: string[];
  migrationsDir: string | null;
  warnings: string[];
}

interface Detected {
  runtime: Runtime;
  packageManager: PackageManager | null;
  install: string | null;
  migrate: string | null;
  seed: string | null;
  build: string | null;
  test: string | null;
  app: PreviewApp | null;
  envRequired: string[];
  migrationsDir: string | null;
  database: {
    required: boolean;
    provider: DatabaseProvider | null;
  };
  warnings: string[];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRelativeDir(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function manifestError(
  root: string,
  path: string,
  message: string,
): PreviewContractError {
  return new PreviewContractError(`${path}: ${message}`, root, path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function parseYaml(text: string, root: string, path: string): unknown {
  // Bun ships a YAML parser; the JSON manifest exists for older runtimes.
  const bun = Bun as unknown as {
    YAML?: { parse(input: string): unknown };
  };
  if (!bun.YAML) {
    throw manifestError(
      root,
      path,
      "Bun.YAML is unavailable in this runtime; use .aikya/preview.json instead",
    );
  }
  return bun.YAML.parse(text);
}

function readScripts(pkg: JsonObject): Record<string, string> {
  const scripts: Record<string, string> = {};
  if (!isObject(pkg.scripts)) return scripts;

  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string" && value.trim()) {
      scripts[name] = value.trim();
    }
  }
  return scripts;
}

function detectPackageManager(
  pkg: JsonObject,
  files: Set<string>,
): PackageManager | null {
  if (typeof pkg.packageManager === "string") {
    const declared = pkg.packageManager.split("@")[0]?.trim();
    if (declared && isPackageManager(declared)) return declared;
  }

  if (files.has("bun.lock") || files.has("bun.lockb")) return "bun";
  if (files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has("yarn.lock")) return "yarn";
  if (files.has("package-lock.json")) return "npm";
  return null;
}

function installCommand(packageManager: PackageManager): string {
  switch (packageManager) {
    case "bun":
      return "bun install --frozen-lockfile";
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "npm":
      return "npm ci";
  }
}

function runCommand(packageManager: PackageManager, script: string): string {
  switch (packageManager) {
    case "bun":
      return `bun run ${script}`;
    case "pnpm":
      return `pnpm run ${script}`;
    case "yarn":
      return `yarn run ${script}`;
    case "npm":
      return `npm run ${script}`;
  }
}

function firstScript(
  scripts: Record<string, string>,
  names: readonly string[],
): string | null {
  for (const name of names) {
    if (scripts[name]) return name;
  }
  return null;
}

function envKeys(text: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (!match?.[1] || seen.has(match[1])) continue;
    seen.add(match[1]);
    keys.push(match[1]);
  }

  return keys;
}

async function readPackageJson(root: string): Promise<JsonObject | null> {
  const path = join(root, "package.json");
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new PreviewContractError(
      `package.json: invalid JSON: ${errorMessage(error)}`,
      root,
    );
  }

  if (!isObject(parsed)) {
    throw new PreviewContractError("package.json: expected a JSON object", root);
  }
  return parsed;
}

function parseManifest(raw: unknown, root: string, path: string): Manifest {
  if (!isObject(raw)) {
    throw manifestError(root, path, "manifest must be a YAML or JSON object");
  }

  if (raw.version !== 1) {
    throw manifestError(
      root,
      path,
      `unsupported version ${JSON.stringify(raw.version)}; expected 1`,
    );
  }

  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!MANIFEST_KEYS.has(key)) {
      warnings.push(`Unknown manifest key "${key}" was ignored.`);
    }
  }

  let runtime: Runtime | null = null;
  if (raw.runtime !== undefined && raw.runtime !== null) {
    if (typeof raw.runtime !== "string" || !raw.runtime.trim()) {
      throw manifestError(root, path, "runtime must be a non-empty string");
    }
    const value = raw.runtime.trim();
    if (value !== "bun" && value !== "node") {
      throw manifestError(
        root,
        path,
        `runtime must be "bun" or "node" (got "${value}")`,
      );
    }
    runtime = value;
  }

  let packageManager: PackageManager | null = null;
  if (raw.packageManager !== undefined && raw.packageManager !== null) {
    if (
      typeof raw.packageManager !== "string" ||
      !isPackageManager(raw.packageManager.trim())
    ) {
      throw manifestError(
        root,
        path,
        `packageManager must be one of ${PACKAGE_MANAGERS.join(", ")}`,
      );
    }
    packageManager = raw.packageManager.trim() as PackageManager;
  }

  let databaseRequired: boolean | null = null;
  let databaseProvider: DatabaseProvider | null = null;
  const database = raw.database;
  if (database !== undefined && database !== null) {
    if (!isObject(database)) {
      throw manifestError(root, path, "database must be an object");
    }
    if (database.required !== undefined && database.required !== null) {
      if (typeof database.required !== "boolean") {
        throw manifestError(root, path, "database.required must be a boolean");
      }
      databaseRequired = database.required;
    }
    if (database.provider !== undefined && database.provider !== null) {
      if (database.provider !== "neon" && database.provider !== "postgres") {
        throw manifestError(
          root,
          path,
          'database.provider must be "neon" or "postgres"',
        );
      }
      databaseProvider = database.provider;
    }
    for (const key of Object.keys(database)) {
      if (key !== "required" && key !== "provider") {
        warnings.push(`Unknown manifest key "database.${key}" was ignored.`);
      }
    }
  }

  const commands: Partial<Record<CommandName, string>> = {};
  const rawCommands = raw.commands;
  if (rawCommands !== undefined && rawCommands !== null) {
    if (!isObject(rawCommands)) {
      throw manifestError(root, path, "commands must be an object");
    }
    for (const name of COMMAND_NAMES) {
      const value = rawCommands[name];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !value.trim()) {
        throw manifestError(
          root,
          path,
          `commands.${name} must be a non-empty string`,
        );
      }
      commands[name] = value.trim();
    }
    for (const key of Object.keys(rawCommands)) {
      if (!(COMMAND_NAMES as readonly string[]).includes(key)) {
        warnings.push(`Unknown manifest key "commands.${key}" was ignored.`);
      }
    }
  }

  let app: PreviewApp | null = null;
  const rawApp = raw.app;
  if (rawApp !== undefined && rawApp !== null) {
    if (!isObject(rawApp)) {
      throw manifestError(root, path, "app must be an object");
    }
    if (typeof rawApp.command !== "string" || !rawApp.command.trim()) {
      throw manifestError(root, path, "app.command is required when app is set");
    }
    let port = 3000;
    if (rawApp.port !== undefined && rawApp.port !== null) {
      if (
        typeof rawApp.port !== "number" ||
        !Number.isInteger(rawApp.port) ||
        rawApp.port <= 0 ||
        rawApp.port > 65535
      ) {
        throw manifestError(
          root,
          path,
          "app.port must be an integer between 1 and 65535",
        );
      }
      port = rawApp.port;
    }
    app = { command: rawApp.command.trim(), port };
    for (const key of Object.keys(rawApp)) {
      if (key !== "command" && key !== "port") {
        warnings.push(`Unknown manifest key "app.${key}" was ignored.`);
      }
    }
  }

  const envRequired: string[] = [];
  const rawEnv = raw.env;
  if (rawEnv !== undefined && rawEnv !== null) {
    if (!isObject(rawEnv)) {
      throw manifestError(root, path, "env must be an object");
    }
    if (rawEnv.required !== undefined && rawEnv.required !== null) {
      if (!Array.isArray(rawEnv.required)) {
        throw manifestError(
          root,
          path,
          "env.required must be an array of variable names",
        );
      }
      for (const entry of rawEnv.required) {
        if (
          typeof entry !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry)
        ) {
          throw manifestError(
            root,
            path,
            `env.required contains an invalid name: ${JSON.stringify(entry)}`,
          );
        }
        envRequired.push(entry);
      }
    }
    for (const key of Object.keys(rawEnv)) {
      if (key !== "required") {
        warnings.push(`Unknown manifest key "env.${key}" was ignored.`);
      }
    }
  }

  let migrationsDir: string | null = null;
  const rawMigrations = raw.migrations;
  if (rawMigrations !== undefined && rawMigrations !== null) {
    if (!isObject(rawMigrations)) {
      throw manifestError(root, path, "migrations must be an object");
    }
    if (rawMigrations.dir !== undefined && rawMigrations.dir !== null) {
      if (
        typeof rawMigrations.dir !== "string" ||
        !rawMigrations.dir.trim()
      ) {
        throw manifestError(
          root,
          path,
          "migrations.dir must be a non-empty string",
        );
      }
      migrationsDir = normalizeRelativeDir(rawMigrations.dir);
    }
    for (const key of Object.keys(rawMigrations)) {
      if (key !== "dir") {
        warnings.push(`Unknown manifest key "migrations.${key}" was ignored.`);
      }
    }
  }

  return {
    runtime,
    packageManager,
    databaseRequired,
    databaseProvider,
    commands,
    app,
    envRequired: [...new Set(envRequired)],
    migrationsDir,
    warnings,
  };
}

async function readManifest(
  root: string,
): Promise<{ manifest: Manifest; path: string } | null> {
  for (const relative of MANIFEST_PATHS) {
    const path = join(root, relative);
    if (!(await exists(path))) continue;

    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw manifestError(root, relative, `could not be read: ${errorMessage(error)}`);
    }

    let raw: unknown;
    try {
      raw =
        relative.endsWith(".json")
          ? (JSON.parse(text) as unknown)
          : parseYaml(text, root, relative);
    } catch (error) {
      if (error instanceof PreviewContractError) throw error;
      throw manifestError(
        root,
        relative,
        `could not be parsed: ${errorMessage(error)}`,
      );
    }

    return { manifest: parseManifest(raw, root, relative), path: relative };
  }

  return null;
}

async function detect(root: string): Promise<Detected | null> {
  const pkg = await readPackageJson(root);
  if (!pkg) return null;

  const entries = await readdir(root);
  const files = new Set(entries);
  const warnings: string[] = [];

  let packageManager = detectPackageManager(pkg, files);
  if (!packageManager) {
    packageManager = "npm";
    warnings.push(
      "No package manager or lockfile detected; assuming npm. Add packageManager to package.json or commit a lockfile.",
    );
  }

  const scripts = readScripts(pkg);
  const runtime: Runtime = packageManager === "bun" ? "bun" : "node";

  const drizzleConfig = [
    "drizzle.config.ts",
    "drizzle.config.js",
    "drizzle.config.mjs",
    "drizzle.config.cjs",
    "drizzle.config.json",
  ].find((name) => files.has(name));

  let migrationsDir: string | null = null;
  if (drizzleConfig) {
    const text = await readFile(join(root, drizzleConfig), "utf8").catch(() => "");
    const out = /["']?out["']?\s*[:=]\s*["']([^"']+)["']/.exec(text)?.[1];
    migrationsDir = out ? normalizeRelativeDir(out) : null;
  }
  if (!migrationsDir && (await isDirectory(join(root, "drizzle")))) {
    migrationsDir = "drizzle";
  }
  if (!migrationsDir && (await isDirectory(join(root, "migrations")))) {
    migrationsDir = "migrations";
  }

  const envFile = [".env.example", ".env.sample", ".env.template"].find((name) =>
    files.has(name),
  );
  const envRequired = envFile
    ? envKeys(await readFile(join(root, envFile), "utf8"))
    : [];

  const dependencyNames = new Set([
    ...Object.keys(isObject(pkg.dependencies) ? pkg.dependencies : {}),
    ...Object.keys(isObject(pkg.devDependencies) ? pkg.devDependencies : {}),
  ]);

  const databaseProvider: DatabaseProvider | null =
    dependencyNames.has("@neondatabase/serverless") ||
    dependencyNames.has("@neondatabase/neon-js")
      ? "neon"
      : dependencyNames.has("pg") || dependencyNames.has("postgres")
        ? "postgres"
        : null;

  const databaseRequired = Boolean(
    drizzleConfig || migrationsDir || envRequired.includes("DATABASE_URL"),
  );

  const migrateScript = firstScript(scripts, ["db:migrate", "migrate"]);
  const seedScript = firstScript(scripts, ["db:seed", "seed"]);
  const appScript = firstScript(scripts, ["dev", "start"]);

  const app = appScript
    ? { command: runCommand(packageManager, appScript), port: 3000 }
    : null;
  if (app) {
    warnings.push(
      "App port was not declared; assuming 3000. Add app.port to .aikya/preview.yml.",
    );
  }

  if (!scripts.test) {
    warnings.push("No test script found; the test step will be skipped.");
  }
  if (databaseRequired && !migrateScript) {
    warnings.push(
      "A database branch is required but no db:migrate or migrate script was found.",
    );
  }
  if (databaseRequired && envRequired.length === 0) {
    warnings.push(
      "No .env.example found; the set of required environment variables is unknown.",
    );
  }

  return {
    runtime,
    packageManager,
    install: installCommand(packageManager),
    migrate: migrateScript ? runCommand(packageManager, migrateScript) : null,
    seed: seedScript ? runCommand(packageManager, seedScript) : null,
    build: scripts.build ? runCommand(packageManager, "build") : null,
    test: scripts.test ? runCommand(packageManager, "test") : null,
    app,
    envRequired,
    migrationsDir,
    database: { required: databaseRequired, provider: databaseProvider },
    warnings,
  };
}

/**
 * Resolve a repository's preview contract. Reads files only: no install, no
 * migrations, no network, and no database access.
 *
 * Throws `PreviewContractError` when neither a manifest nor a package.json
 * exists, or when the manifest is invalid.
 */
export async function resolvePreviewContract(
  root: string = process.cwd(),
): Promise<PreviewContract> {
  const absolute = resolve(root);
  const manifest = await readManifest(absolute);
  const detected = await detect(absolute);

  if (!manifest && !detected) {
    throw new PreviewContractError(
      `No preview contract found in ${absolute}. Add .aikya/preview.yml (recommended) or a package.json.`,
      absolute,
    );
  }

  const warnings = [
    ...(manifest?.manifest.warnings ?? []),
    ...(detected?.warnings ?? []),
  ];

  if (manifest) {
    // Detection warns about missing scripts and an undeclared app port. When a
    // manifest declares the command or port, those detection warnings are
    // noise; keep only manifest-level warnings.
    const filtered = warnings.filter((warning) => {
      if (
        warning === "No test script found; the test step will be skipped."
      ) {
        return manifest.manifest.commands.test == null;
      }
      if (warning.startsWith("App port was not declared;")) {
        return manifest.manifest.app == null;
      }
      return true;
    });
    warnings.splice(0, warnings.length, ...filtered);
  }

  if (!manifest) {
    warnings.unshift(
      "No .aikya/preview.yml; commands were inferred from repository files. Commit a manifest to make the preview reproducible.",
    );
  }
  if (manifest && !detected) {
    warnings.push("No package.json found; commands come from the manifest only.");
  }

  const declared = manifest?.manifest.commands;
  const command = (name: CommandName): string | null =>
    declared?.[name] ?? detected?.[name] ?? null;

  const databaseRequired =
    manifest?.manifest.databaseRequired ?? detected?.database.required ?? false;
  const databaseProvider =
    manifest?.manifest.databaseProvider ?? detected?.database.provider ?? null;

  return {
    version: 1,
    source: manifest ? "manifest" : "detected",
    root: absolute,
    manifestPath: manifest?.path ?? null,
    runtime: manifest?.manifest.runtime ?? detected?.runtime ?? "node",
    packageManager:
      manifest?.manifest.packageManager ?? detected?.packageManager ?? null,
    install: command("install"),
    migrate: command("migrate"),
    seed: command("seed"),
    build: command("build"),
    test: command("test"),
    app: manifest?.manifest.app ?? detected?.app ?? null,
    envRequired: [
      ...new Set([
        ...(manifest?.manifest.envRequired ?? []),
        ...(detected?.envRequired ?? []),
      ]),
    ],
    migrationsDir:
      manifest?.manifest.migrationsDir ?? detected?.migrationsDir ?? null,
    database: { required: databaseRequired, provider: databaseProvider },
    warnings: [...new Set(warnings)],
  };
}
