import fs from "node:fs";
// Standalone output assembly works entirely in native-separator space: it
// copies directory trees with fs.cpSync filters that split on path.sep and
// never feeds paths back into id/URL comparisons, so pathslash buys nothing.
// oxlint-disable-next-line no-restricted-imports
import path from "node:path";
import { createRequire } from "node:module";
import { readJsonFile } from "../utils/safe-json-file.js";
import { resolveVinextPackageRoot } from "../utils/vinext-root.js";

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type StandaloneBuildOptions = {
  root: string;
  outDir: string;
  /**
   * Test hook: override vinext package root used for embedding runtime files.
   */
  vinextPackageRoot?: string;
};

type StandaloneBuildResult = {
  standaloneDir: string;
  copiedPackages: string[];
};

type QueueEntry = {
  packageName: string;
  resolver: NodeRequire;
  optional: boolean;
  /** Standalone directory of the package that depends on this one. */
  dependentDir: string;
};

type CopyState = {
  copied: Set<string>;
  /** Each standalone directory written, mapped to the real package directory it was copied from. */
  placements: Map<string, string>;
  /**
   * Packages the server bundle imports directly. They keep the single top-level
   * copy the app root resolves and a dependent never gets its own version, since
   * a second copy would split shared state such as React's.
   */
  serverImports: ReadonlySet<string>;
};

function readPackageJson(packageJsonPath: string): PackageJson {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as PackageJson;
}

/** Returns both `dependencies` and `optionalDependencies` keys — the full set of potential runtime deps. */
function runtimeDeps(pkg: PackageJson): string[] {
  return Object.keys({
    ...pkg.dependencies,
    ...pkg.optionalDependencies,
  });
}

/**
 * Read the externals manifest written by the `vinext:server-externals-manifest`
 * Vite plugin during the production build.
 *
 * The manifest (`dist/server/vinext-externals.json`) contains the exact set of
 * npm packages that the bundler left external in the SSR/RSC output — i.e.
 * packages that the server bundle actually imports at runtime. Using this
 * instead of scanning emitted files with regexes or seeding from
 * `package.json#dependencies` avoids both false negatives (missed imports) and
 * false positives (client-only deps that are never loaded server-side).
 *
 * Falls back to an empty array if the manifest does not exist (e.g. when
 * running against a build that predates this feature).
 */
function readServerExternalsManifest(serverDir: string): string[] {
  const manifestPath = path.join(serverDir, "vinext-externals.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  return (
    readJsonFile<string[]>(manifestPath, {
      onError: (err) => {
        console.warn(
          `[vinext] Warning: failed to parse ${manifestPath}, proceeding without externals manifest: ${String(err)}`,
        );
      },
    }) ?? []
  );
}

function resolvePackageJsonPath(packageName: string, resolver: NodeRequire): string | null {
  try {
    return resolver.resolve(`${packageName}/package.json`);
  } catch {
    // Some packages only expose subpath exports (for example `rsc-html-stream`,
    // which exports `./server` but not `.` or `./package.json`). resolver.resolve()
    // cannot access those hidden paths, but Node still exposes the installed
    // node_modules lookup locations via resolve.paths().
    const lookupPaths = resolver.resolve.paths(packageName) ?? [];
    for (const lookupPath of lookupPaths) {
      const candidate = path.join(lookupPath, packageName, "package.json");
      if (fs.existsSync(candidate)) {
        const pkg = readPackageJson(candidate);
        if (pkg.name === packageName) {
          return candidate;
        }
      }
    }

    // Some packages do not export ./package.json via exports map.
    // Fallback: resolve package entry and walk up to the nearest matching package.json.
    try {
      const entryPath = resolver.resolve(packageName);
      let dir = path.dirname(entryPath);
      while (dir !== path.dirname(dir)) {
        const candidate = path.join(dir, "package.json");
        if (fs.existsSync(candidate)) {
          const pkg = readPackageJson(candidate);
          if (pkg.name === packageName) {
            return candidate;
          }
        }
        dir = path.dirname(dir);
      }
    } catch {
      // fallthrough to null
    }
    return null;
  }
}

/** The node_modules directories Node searches from `fromDir`, innermost first, up to `rootDir`. */
function nodeModulesLookupDirs(fromDir: string, rootDir: string): string[] {
  const dirs: string[] = [];
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules") {
      dirs.push(path.join(dir, "node_modules"));
    }
    if (dir === rootDir || dir === path.dirname(dir)) {
      return dirs;
    }
  }
}

/**
 * Copies each package and its runtime dependencies into `targetNodeModulesDir`
 * so that every copied package loads the version of each dependency it resolves
 * in the workspace.
 *
 * A package goes to the top level of node_modules when that slot is free. When
 * the slot already holds a different version, the package goes into the
 * node_modules of the dependent that needs it, where Node finds it before the
 * top-level copy. Every call that writes into the same node_modules must share
 * `state`.
 */
function copyPackageAndRuntimeDeps(
  root: string,
  targetNodeModulesDir: string,
  initialPackages: string[],
  state: CopyState,
  initialDependentDir: string = path.dirname(targetNodeModulesDir),
): void {
  const rootResolver = createRequire(path.join(root, "package.json"));
  const rootPkg = readPackageJson(path.join(root, "package.json"));
  const rootOptional = new Set(Object.keys(rootPkg.optionalDependencies ?? {}));
  const { copied, placements, serverImports } = state;
  const standaloneDir = path.dirname(targetNodeModulesDir);
  const queue: QueueEntry[] = initialPackages.map((packageName) => ({
    packageName,
    resolver: rootResolver,
    optional: rootOptional.has(packageName),
    dependentDir: initialDependentDir,
  }));

  while (queue.length > 0) {
    const entry = queue.shift();
    if (!entry) continue;

    const topLevelTarget = path.join(targetNodeModulesDir, entry.packageName);
    if (serverImports.has(entry.packageName) && placements.has(topLevelTarget)) continue;

    const packageJsonPath = resolvePackageJsonPath(entry.packageName, entry.resolver);
    if (!packageJsonPath) {
      if (entry.optional) {
        continue;
      }
      throw new Error(
        `Failed to resolve required runtime dependency "${entry.packageName}" for standalone output`,
      );
    }

    const realPackageJsonPath = fs.realpathSync(packageJsonPath);
    const packageRoot = path.dirname(realPackageJsonPath);

    // Skip when the copy Node would load from the dependent is already this one.
    const loaded = nodeModulesLookupDirs(entry.dependentDir, standaloneDir)
      .map((dir) => path.join(dir, entry.packageName))
      .find((dir) => placements.has(dir));
    if (loaded !== undefined && placements.get(loaded) === packageRoot) continue;

    const packageTarget = placements.has(topLevelTarget)
      ? path.join(entry.dependentDir, "node_modules", entry.packageName)
      : topLevelTarget;
    if (placements.has(packageTarget)) continue;

    fs.mkdirSync(path.dirname(packageTarget), { recursive: true });
    fs.cpSync(packageRoot, packageTarget, {
      recursive: true,
      dereference: true,
      // Skip any nested node_modules/ inside the package — the BFS walk
      // resolves deps at their correct hoisted location, so nested copies
      // would be stale duplicates. Use path segment splitting so that a
      // directory merely containing "node_modules" as a substring (e.g.
      // "not_node_modules_v2") is not accidentally filtered out.
      filter: (src) => {
        const rel = path.relative(packageRoot, src);
        return !rel.split(path.sep).includes("node_modules");
      },
    });

    placements.set(packageTarget, packageRoot);
    copied.add(entry.packageName);

    const packageResolver = createRequire(realPackageJsonPath);
    const pkg = readPackageJson(realPackageJsonPath);
    const optionalDeps = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const depName of runtimeDeps(pkg)) {
      queue.push({
        packageName: depName,
        resolver: packageResolver,
        optional: optionalDeps.has(depName),
        dependentDir: packageTarget,
      });
    }
  }
}

function writeStandaloneServerEntry(filePath: string): void {
  // Uses import.meta.dirname (Node >= 21.2, vinext requires >= 22) so the
  // entry point is pure ESM — no need for CJS require() or __dirname.
  //
  // The static import of "vinext/server/prod-server" is intentional: that
  // subpath is a documented export in vinext's package.json exports map and
  // is always present in the standalone node_modules/vinext/dist tree
  // (emitStandaloneOutput copies vinext's dist/ directory in full). A static
  // import gives a clearer ERR_MODULE_NOT_FOUND at startup rather than a
  // runtime error deep inside the server if the import were deferred.
  const content = `#!/usr/bin/env node
import { join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

startProdServer({
  port,
  host,
  outDir: join(import.meta.dirname, "dist"),
}).catch((error) => {
  console.error("[vinext] Failed to start standalone server");
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(filePath, content, "utf-8");
  fs.chmodSync(filePath, 0o755);
}

function writeStandalonePackageJson(filePath: string): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
}

/**
 * Emit standalone production output for self-hosted deployments.
 *
 * Creates:
 * - <outDir>/standalone/server.js
 * - <outDir>/standalone/dist/{client,server}
 * - <outDir>/standalone/node_modules (runtime deps only)
 *
 * The set of packages copied into node_modules/ is determined by
 * `dist/server/vinext-externals.json`, which is written by the
 * `vinext:server-externals-manifest` Vite plugin during the production build.
 * It contains exactly the packages the server bundle imports at runtime
 * (i.e. those left external by the bundler), so no client-only deps are
 * included.
 */
export function emitStandaloneOutput(options: StandaloneBuildOptions): StandaloneBuildResult {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const clientDir = path.join(outDir, "client");
  const serverDir = path.join(outDir, "server");

  if (!fs.existsSync(clientDir) || !fs.existsSync(serverDir)) {
    throw new Error(`No build output found in ${outDir}. Run vite build first.`);
  }

  const standaloneDir = path.join(outDir, "standalone");
  const standaloneDistDir = path.join(standaloneDir, "dist");
  const standaloneNodeModulesDir = path.join(standaloneDir, "node_modules");

  fs.rmSync(standaloneDir, { recursive: true, force: true });
  fs.mkdirSync(standaloneDistDir, { recursive: true });

  fs.cpSync(clientDir, path.join(standaloneDistDir, "client"), {
    recursive: true,
    dereference: true,
    // Build output shouldn't contain node_modules, but filter defensively for
    // consistency with the other cpSync calls in this function.
    filter: (src) => !path.relative(clientDir, src).split(path.sep).includes("node_modules"),
  });
  fs.cpSync(serverDir, path.join(standaloneDistDir, "server"), {
    recursive: true,
    dereference: true,
    filter: (src) => !path.relative(serverDir, src).split(path.sep).includes("node_modules"),
  });
  const clientAssetsSidecar = path.join(outDir, "vinext-client-assets.js");
  if (fs.existsSync(clientAssetsSidecar)) {
    fs.copyFileSync(clientAssetsSidecar, path.join(standaloneDistDir, "vinext-client-assets.js"));
  }

  const publicDir = path.join(root, "public");
  if (fs.existsSync(publicDir)) {
    fs.cpSync(publicDir, path.join(standaloneDir, "public"), {
      recursive: true,
      dereference: true,
      // Defensive: public/ containing node_modules is extremely unlikely but
      // filter for consistency with the other cpSync calls in this function.
      filter: (src) => !path.relative(publicDir, src).split(path.sep).includes("node_modules"),
    });
  }

  fs.mkdirSync(standaloneNodeModulesDir, { recursive: true });

  // Seed from the manifest written by vinext:server-externals-manifest during
  // the production build. This is the authoritative list of packages the server
  // bundle actually imports at runtime — determined by the bundler's own graph,
  // not regex scanning or package.json#dependencies.
  //
  // The manifest is always written to dist/server/vinext-externals.json regardless
  // of whether the build is App Router (rsc + ssr sub-dirs) or Pages Router (ssr
  // only). The plugin walks up from options.dir to find the "server" ancestor, so
  // both dist/server (Pages Router) and dist/server/ssr (App Router SSR) resolve
  // to the same dist/server output path.
  const initialPackages = readServerExternalsManifest(serverDir).filter(
    (name) => name !== "vinext",
  );
  const copyState: CopyState = {
    copied: new Set<string>(),
    placements: new Map<string, string>(),
    serverImports: new Set(initialPackages),
  };
  copyPackageAndRuntimeDeps(root, standaloneNodeModulesDir, initialPackages, copyState);

  // Always embed the exact vinext runtime that produced this build.
  const vinextPackageRoot = resolveVinextPackageRoot(options.vinextPackageRoot);
  const vinextDistDir = path.join(vinextPackageRoot, "dist");
  if (!fs.existsSync(vinextDistDir)) {
    throw new Error(`vinext runtime dist/ not found at ${vinextPackageRoot}`);
  }
  const vinextTargetDir = path.join(standaloneNodeModulesDir, "vinext");
  fs.mkdirSync(vinextTargetDir, { recursive: true });
  fs.copyFileSync(
    path.join(vinextPackageRoot, "package.json"),
    path.join(vinextTargetDir, "package.json"),
  );
  fs.cpSync(vinextDistDir, path.join(vinextTargetDir, "dist"), {
    recursive: true,
    dereference: true,
    // Defensive: skip any node_modules/ that may exist inside vinext's dist/.
    filter: (src) => {
      const rel = path.relative(vinextDistDir, src);
      return !rel.split(path.sep).includes("node_modules");
    },
  });
  copyState.copied.add("vinext");
  copyState.placements.set(vinextTargetDir, fs.realpathSync(vinextPackageRoot));

  // Copy vinext's own runtime dependencies. The prod-server imports packages
  // like `rsc-html-stream` at runtime; they must be present in standalone
  // node_modules/ even if the user's app doesn't depend on them directly.
  // We resolve them from vinext's package root so nested requires work correctly.
  const vinextPkg = readPackageJson(path.join(vinextPackageRoot, "package.json"));
  copyPackageAndRuntimeDeps(
    vinextPackageRoot,
    standaloneNodeModulesDir,
    runtimeDeps(vinextPkg),
    copyState,
    vinextTargetDir,
  );

  writeStandaloneServerEntry(path.join(standaloneDir, "server.js"));
  writeStandalonePackageJson(path.join(standaloneDir, "package.json"));

  return {
    standaloneDir,
    copiedPackages: [...copyState.copied],
  };
}
