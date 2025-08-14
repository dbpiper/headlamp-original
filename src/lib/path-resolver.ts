import * as path from 'node:path';
import * as fsSync from 'node:fs';

const INDEX_NOT_FOUND = -1;
const ZERO = 0;
const ONE = 1;

type TsLikePathsConfig = {
  readonly configDir: string;
  readonly baseUrl?: string;
  readonly paths?: Record<string, readonly string[]>;
};

type JestAliasConfig = {
  readonly configDir: string;
  readonly mappers: ReadonlyArray<{ pattern: RegExp; target: string }>;
  readonly moduleDirs: ReadonlyArray<string>;
};

type BabelAliasConfig = {
  readonly configDir: string;
  readonly aliases: Record<string, string>;
  readonly roots: ReadonlyArray<string>;
  readonly extensions: ReadonlyArray<string>;
};

type ModuleResolverOptions = {
  alias?: Record<string, string>;
  root?: readonly string[];
  extensions?: readonly string[];
};

type MetroAliasConfig = {
  readonly configDir: string;
  readonly aliases: Record<string, string>;
};

const tsConfigLookupCache = new Map<string, TsLikePathsConfig | null>();
const jestConfigLookupCache = new Map<string, JestAliasConfig | null>();
const babelConfigLookupCache = new Map<string, BabelAliasConfig | null>();
const metroConfigLookupCache = new Map<string, MetroAliasConfig | null>();

const FILE_EXTS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.json',
] as const;

export const tryResolveFile = (candidateBase: string): string | undefined => {
  for (const ext of FILE_EXTS) {
    const full = ext ? `${candidateBase}${ext}` : candidateBase;
    if (fsSync.existsSync(full)) {
      try {
        const stat = fsSync.statSync(full);
        if (stat.isFile()) {
          return path.resolve(full).replace(/\\/g, '/');
        }
      } catch {
        // ignore
      }
    }
  }
  for (const ext of FILE_EXTS) {
    const full = path.join(candidateBase, `index${ext}`);
    if (fsSync.existsSync(full)) {
      return path.resolve(full).replace(/\\/g, '/');
    }
  }
  return undefined;
};

const JEST_CONFIG_FILENAMES = [
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
  'jest.config.ts',
  'jest.config.cts',
];

const loadNearestJestConfig = (startDir: string, rootDir: string): JestAliasConfig | null => {
  let cur = startDir;
  while (cur.startsWith(rootDir)) {
    const cached = jestConfigLookupCache.get(cur);
    if (cached !== undefined) {
      return cached;
    }
    let filePath: string | undefined;
    for (const configFileName of JEST_CONFIG_FILENAMES) {
      const candidatePath = path.join(cur, configFileName);
      if (fsSync.existsSync(candidatePath)) {
        filePath = candidatePath;
        break;
      }
    }
    if (filePath) {
      try {
        const raw = fsSync.readFileSync(filePath, 'utf8');
        const mappers: Array<{ pattern: RegExp; target: string }> = [];
        const moduleDirs: string[] = [];
        const mapperBlockMatch = raw.match(/moduleNameMapper\s*:\s*\{([\s\S]*?)\}/m);
        if (mapperBlockMatch) {
          const [, body = ''] = mapperBlockMatch;
          const pairRe = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
          let matchResult: RegExpExecArray | null;
          // eslint-disable-next-line no-cond-assign
          while ((matchResult = pairRe.exec(body))) {
            const [, patternSrcRaw, targetRaw] = matchResult as unknown as [string, string, string];
            if (patternSrcRaw && targetRaw) {
              try {
                const pattern = new RegExp(patternSrcRaw);
                mappers.push({ pattern, target: targetRaw });
              } catch {
                // ignore invalid regex entries
              }
            }
          }
        }
        const dirsMatch = raw.match(/moduleDirectories\s*:\s*\[([^\]]*?)\]/m);
        if (dirsMatch) {
          const [, arr = ''] = dirsMatch;
          const strRe = /["']([^"']+)["']/g;
          let dirMatch: RegExpExecArray | null;
          // eslint-disable-next-line no-cond-assign
          while ((dirMatch = strRe.exec(arr))) {
            const [, capturedDirRaw] = dirMatch as unknown as [string, string];
            if (capturedDirRaw && capturedDirRaw.length > ZERO) {
              moduleDirs.push(capturedDirRaw);
            }
          }
        }
        const cfg: JestAliasConfig = {
          configDir: path.dirname(filePath),
          mappers,
          moduleDirs,
        };
        jestConfigLookupCache.set(cur, cfg);
        return cfg;
      } catch {
        jestConfigLookupCache.set(cur, null);
        return null;
      }
    }
    jestConfigLookupCache.set(cur, null);
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return null;
};

const applyJestMappings = (spec: string, cfg: JestAliasConfig): string | undefined => {
  for (const mapping of cfg.mappers) {
    const { pattern, target } = mapping;
    if (pattern.test(spec)) {
      const replacedRoot = target.replace(/<rootDir>/g, cfg.configDir);
      const candidate = spec.replace(pattern, replacedRoot);
      const res = tryResolveFile(candidate);
      if (res) {
        return res;
      }
    }
  }
  for (const dir of cfg.moduleDirs) {
    if (dir !== 'node_modules') {
      const base = path.isAbsolute(dir) ? dir : path.resolve(cfg.configDir, dir);
      const res = tryResolveFile(path.join(base, spec));
      if (res) {
        return res;
      }
    }
  }
  return undefined;
};

const BABEL_CONFIG_FILENAMES = [
  '.babelrc',
  '.babelrc.json',
  'babel.config.js',
  'babel.config.cjs',
  'babel.config.mjs',
  'babel.config.ts',
  'babel.config.cts',
];

const MODULE_RESOLVER_NAMES = new Set([
  'module-resolver',
  'babel-plugin-module-resolver',
  '@babel/plugin-module-resolver',
]);

const loadNearestBabelConfig = (startDir: string, rootDir: string): BabelAliasConfig | null => {
  let cur = startDir;
  while (cur.startsWith(rootDir)) {
    const cached = babelConfigLookupCache.get(cur);
    if (cached !== undefined) {
      return cached;
    }
    let filePath: string | undefined;
    for (const name of BABEL_CONFIG_FILENAMES) {
      const candidatePath = path.join(cur, name);
      if (fsSync.existsSync(candidatePath)) {
        filePath = candidatePath;
        break;
      }
    }
    if (filePath) {
      try {
        const raw = fsSync.readFileSync(filePath, 'utf8');
        let aliases: Record<string, string> = {};
        const roots: string[] = [];
        const extensions: string[] = [];
        if (filePath.endsWith('.json') || path.basename(filePath) === '.babelrc') {
          try {
            const json = JSON.parse(raw) as { plugins?: unknown };
            const plugins = (json.plugins as unknown[]) || [];
            for (const pluginEntry of plugins) {
              if (Array.isArray(pluginEntry)) {
                const [pluginNameRaw, pluginOptionsRaw] = pluginEntry as [unknown, unknown];
                if (typeof pluginNameRaw === 'string' && MODULE_RESOLVER_NAMES.has(pluginNameRaw)) {
                  const opts: ModuleResolverOptions =
                    (pluginOptionsRaw as ModuleResolverOptions) || {};
                  if (opts.alias && typeof opts.alias === 'object') {
                    aliases = { ...aliases, ...opts.alias };
                  }
                  const rootArr = Array.isArray(opts.root) ? opts.root : [];
                  for (const rootEntry of rootArr) {
                    if (typeof rootEntry === 'string') {
                      roots.push(rootEntry);
                    }
                  }
                  const extArr = Array.isArray(opts.extensions) ? opts.extensions : [];
                  for (const extEntry of extArr) {
                    if (typeof extEntry === 'string') {
                      extensions.push(extEntry);
                    }
                  }
                }
              }
            }
          } catch {
            // ignore JSON parse
          }
        }
        const cfg: BabelAliasConfig = {
          configDir: path.dirname(filePath),
          aliases,
          roots,
          extensions,
        };
        babelConfigLookupCache.set(cur, cfg);
        return cfg;
      } catch {
        babelConfigLookupCache.set(cur, null);
        return null;
      }
    }
    babelConfigLookupCache.set(cur, null);
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return null;
};

const applyBabelMappings = (spec: string, cfg: BabelAliasConfig): string | undefined => {
  const keys = Object.keys(cfg.aliases);
  let best: string | undefined;
  for (const key of keys) {
    if (matchPathKey(spec, key)) {
      if (!best || key.length > best.length) {
        best = key;
      }
    }
  }
  if (!best) {
    return undefined;
  }
  const replaced = replacePathKey(spec, best);
  const targetTmpl = cfg.aliases[best] ?? '';
  const targetPath = targetTmpl.includes('*') ? targetTmpl.replace('*', replaced) : targetTmpl;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cfg.configDir, targetPath);
  const res = tryResolveFile(abs);
  if (res) {
    return res;
  }
  if (!targetTmpl.includes('*') && replaced) {
    const joined = path.join(abs, replaced);
    const r2 = tryResolveFile(joined);
    if (r2) {
      return r2;
    }
  }
  for (const rootBase of cfg.roots) {
    const base = path.isAbsolute(rootBase) ? rootBase : path.resolve(cfg.configDir, rootBase);
    const r3 = tryResolveFile(path.join(base, spec));
    if (r3) {
      return r3;
    }
  }
  return undefined;
};

const METRO_CONFIG_FILENAMES = ['metro.config.js', 'metro.config.cjs', 'metro.config.mjs'];

const loadNearestMetroConfig = (startDir: string, rootDir: string): MetroAliasConfig | null => {
  let cur = startDir;
  while (cur.startsWith(rootDir)) {
    const cached = metroConfigLookupCache.get(cur);
    if (cached !== undefined) {
      return cached;
    }
    let filePath: string | undefined;
    for (const configFileName of METRO_CONFIG_FILENAMES) {
      const candidatePath = path.join(cur, configFileName);
      if (fsSync.existsSync(candidatePath)) {
        filePath = candidatePath;
        break;
      }
    }
    if (filePath) {
      try {
        const raw = fsSync.readFileSync(filePath, 'utf8');
        const varMap = new Map<string, string>();
        varMap.set('__dirname', path.dirname(filePath));
        const projectRootMatch = raw.match(/const\s+projectRoot\s*=\s*__dirname\s*;/);
        if (projectRootMatch) {
          varMap.set('projectRoot', path.dirname(filePath));
        }
        const workspaceRootMatch = raw.match(
          /const\s+workspaceRoot\s*=\s*path\.resolve\(\s*projectRoot\s*,\s*['"]([^'"]+)['"]\s*\)/,
        );
        if (workspaceRootMatch) {
          const [, rel = ''] = workspaceRootMatch;
          const base = varMap.get('projectRoot') ?? path.dirname(filePath);
          if (rel) {
            varMap.set('workspaceRoot', path.resolve(base, rel));
          }
        }
        const extraMatch = raw.match(/extraNodeModules\s*=\s*\{([\s\S]*?)\}/m);
        const aliases: Record<string, string> = {};
        if (extraMatch) {
          const body = extraMatch[1] ?? '';
          const pairRe = /["']([^"']+)["']\s*:\s*([^,]+),?/g;
          let pairMatch: RegExpExecArray | null;
          // eslint-disable-next-line no-cond-assign
          while ((pairMatch = pairRe.exec(body))) {
            const [, aliasKeyRaw, rhsRaw] = pairMatch as unknown as [string, string, string];
            const aliasKey = aliasKeyRaw ?? '';
            const rhs = (rhsRaw ?? '').trim();
            let resolved: string | undefined;
            const strMatch = rhs.match(/^["']([^"']+)["']$/);
            if (strMatch && strMatch[1]) {
              const strVal = strMatch[1] as string;
              resolved = path.isAbsolute(strVal)
                ? strVal
                : path.resolve(path.dirname(filePath), strVal);
            } else {
              const resMatch = rhs.match(
                /path\.resolve\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*['"]([^'"]+)['"]\s*\)/,
              );
              if (resMatch && resMatch[1] && resMatch[2]) {
                const varName = resMatch[1] as string;
                const segment = resMatch[2] as string;
                const base = varMap.get(varName) ?? path.dirname(filePath);
                resolved = path.resolve(base, segment);
              }
            }
            if (aliasKey && resolved) {
              aliases[aliasKey] = resolved;
            }
          }
        }
        const cfg: MetroAliasConfig = { configDir: path.dirname(filePath), aliases };
        metroConfigLookupCache.set(cur, cfg);
        return cfg;
      } catch {
        metroConfigLookupCache.set(cur, null);
        return null;
      }
    }
    metroConfigLookupCache.set(cur, null);
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return null;
};

const applyMetroMappings = (spec: string, cfg: MetroAliasConfig): string | undefined => {
  const entries = Object.entries(cfg.aliases);
  let bestKey: string | undefined;
  for (const [alias] of entries) {
    if (spec === alias || spec.startsWith(`${alias}/`)) {
      if (!bestKey || alias.length > bestKey.length) {
        bestKey = alias;
      }
    }
  }
  if (!bestKey) {
    return undefined;
  }
  const sureKey = bestKey as string;
  const base = cfg.aliases[sureKey] ?? '';
  if (!base) {
    return undefined;
  }
  const remainder = spec === sureKey ? '' : spec.slice(sureKey.length + 1);
  const candidate = remainder ? path.join(base, remainder) : base;
  const res = tryResolveFile(candidate);
  return res;
};

const loadNearestTsOrJsConfig = (startDir: string, rootDir: string): TsLikePathsConfig | null => {
  let cur = startDir;
  while (cur.startsWith(rootDir)) {
    const cached = tsConfigLookupCache.get(cur);
    if (cached !== undefined) {
      return cached;
    }
    const tsPath = path.join(cur, 'tsconfig.json');
    const jsPath = path.join(cur, 'jsconfig.json');
    if (fsSync.existsSync(tsPath) || fsSync.existsSync(jsPath)) {
      const filePath = fsSync.existsSync(tsPath) ? tsPath : jsPath;
      try {
        const raw = fsSync.readFileSync(filePath, 'utf8');
        const json = JSON.parse(raw) as unknown;
        const compilerOptionsRaw = (json as { compilerOptions?: unknown }).compilerOptions ?? {};
        const { baseUrl: baseUrlRaw, paths } = compilerOptionsRaw as {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
        const baseUrl = baseUrlRaw ? path.resolve(cur, baseUrlRaw) : undefined;
        const cfg: TsLikePathsConfig = {
          configDir: cur,
          ...(baseUrl ? { baseUrl } : {}),
          ...(paths ? { paths } : {}),
        };
        tsConfigLookupCache.set(cur, cfg);
        return cfg;
      } catch {
        tsConfigLookupCache.set(cur, null);
        return null;
      }
    }
    tsConfigLookupCache.set(cur, null);
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return null;
};

const applyPathsMapping = (spec: string, cfg: TsLikePathsConfig): string | undefined => {
  const map = cfg.paths;
  if (!map) {
    return undefined;
  }
  let bestKey: string | undefined;
  for (const key of Object.keys(map)) {
    if (matchPathKey(spec, key)) {
      if (!bestKey || key.length > bestKey.length) {
        bestKey = key;
      }
    }
  }
  if (!bestKey) {
    return undefined;
  }
  const targets = map[bestKey] ?? [];
  const replaced = replacePathKey(spec, bestKey);
  for (const target of targets) {
    const targetPath = target.includes('*') ? target.replace('*', replaced) : target;
    const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(cfg.configDir, targetPath);
    const res = tryResolveFile(abs);
    if (res) {
      return res;
    }
  }
  return undefined;
};

function matchPathKey(spec: string, key: string): boolean {
  if (key === spec) {
    return true;
  }
  const starIdx = key.indexOf('*');
  if (starIdx === INDEX_NOT_FOUND) {
    return false;
  }
  const prefix = key.slice(ZERO, starIdx);
  const suffix = key.slice(starIdx + ONE);
  return spec.startsWith(prefix) && spec.endsWith(suffix);
}

function replacePathKey(spec: string, key: string): string {
  if (key === spec) {
    return '';
  }
  const starIdx = key.indexOf('*');
  if (starIdx === INDEX_NOT_FOUND) {
    return '';
  }
  const prefix = key.slice(ZERO, starIdx);
  const suffix = key.slice(starIdx + ONE);
  return spec.slice(prefix.length, spec.length - suffix.length);
}

function resolveWithAliases(fromFile: string, spec: string, rootDir: string): string | undefined {
  const startDir = path.dirname(fromFile);
  let cur: string | undefined = startDir;
  while (cur && cur.startsWith(rootDir)) {
    const tsCfg = loadNearestTsOrJsConfig(cur, rootDir);
    if (tsCfg) {
      const viaPaths = applyPathsMapping(spec, tsCfg);
      if (viaPaths) {
        return viaPaths;
      }
      if (tsCfg.baseUrl) {
        const viaBase = tryResolveFile(path.join(tsCfg.baseUrl, spec));
        if (viaBase) {
          return viaBase;
        }
      }
    }
    const babelCfg = loadNearestBabelConfig(cur, rootDir);
    if (babelCfg) {
      const viaBabel = applyBabelMappings(spec, babelCfg);
      if (viaBabel) {
        return viaBabel;
      }
    }
    const jestCfg = loadNearestJestConfig(cur, rootDir);
    if (jestCfg) {
      const viaJest = applyJestMappings(spec, jestCfg);
      if (viaJest) {
        return viaJest;
      }
    }
    const metroCfg = loadNearestMetroConfig(cur, rootDir);
    if (metroCfg) {
      const viaMetro = applyMetroMappings(spec, metroCfg);
      if (viaMetro) {
        return viaMetro;
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return undefined;
}

export const resolveImportWithRoot = (
  fromFile: string,
  spec: string,
  rootDir: string,
  cache: Map<string, string | undefined>,
): string | undefined => {
  const key = `${fromFile}|${spec}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  let resolved: string | undefined;
  const baseDir = path.dirname(fromFile);
  const isProjectAbs = spec.startsWith('/');
  const candidateBase = isProjectAbs
    ? path.join(rootDir, spec.slice(ONE))
    : path.resolve(baseDir, spec);
  for (const ext of FILE_EXTS) {
    const full = ext ? `${candidateBase}${ext}` : candidateBase;
    if (fsSync.existsSync(full)) {
      resolved = path.resolve(full).replace(/\\/g, '/');
      break;
    }
  }
  if (!resolved) {
    for (const ext of FILE_EXTS) {
      const full = path.join(candidateBase, `index${ext}`);
      if (fsSync.existsSync(full)) {
        resolved = path.resolve(full).replace(/\\/g, '/');
        break;
      }
    }
  }
  if (!resolved && !spec.startsWith('.') && !spec.startsWith('/')) {
    resolved = resolveWithAliases(fromFile, spec, rootDir);
  }
  cache.set(key, resolved);
  return resolved;
};
