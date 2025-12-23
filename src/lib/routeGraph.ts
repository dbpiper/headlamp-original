import * as path from 'node:path';
import { promises as fs, constants as FsConstants } from 'node:fs';

import * as ts from 'typescript';

import { ripgrepSearch } from './ripgrep-utils';
import { DEFAULT_TEST_GLOBS } from './fast-related';
import { collectRouteHandlers, emptyRouteTrie, insertRoute } from './routeTree';
import { pipe } from './fp';
import { toPosix } from './paths';

type RouteUse = Readonly<{
  readonly path: string;
  readonly targets: ReadonlyArray<string>;
  readonly container: string;
}>;

type RouteHandler = Readonly<{
  readonly method: string;
  readonly path: string;
  readonly identifiers: ReadonlyArray<string>;
  readonly container: string;
}>;

type ImportDescriptor = Readonly<{
  readonly local: string;
  readonly specifier: string;
}>;

const readStringLiteralText = (expr: ts.Expression | undefined): string | undefined =>
  expr && ts.isStringLiteral(expr) ? expr.text : undefined;

const readIdentifierText = (id: ts.Identifier | undefined): string | undefined =>
  id ? String(id.escapedText) : undefined;

const readModuleExportNameText = (name: ts.ModuleExportName | undefined): string | undefined =>
  !name ? undefined : ts.isIdentifier(name) ? String(name.escapedText) : name.text;

type ContainerRoutes = Readonly<{
  readonly uses: ReadonlyArray<RouteUse>;
  readonly handlers: ReadonlyArray<RouteHandler>;
}>;

type FileRouteInfo = Readonly<{
  readonly filePath: string;
  readonly imports: ReadonlyMap<string, string>;
  readonly routerContainers: ReadonlySet<string>;
  readonly appContainers: ReadonlySet<string>;
  readonly containerRoutes: ReadonlyMap<string, ContainerRoutes>;
  readonly exportsRouter: boolean;
}>;

export type RouteIndex = Readonly<{
  readonly sourcesForHttpRoute: (httpPath: string) => ReadonlyArray<string>;
  readonly httpRoutesForSource: (sourcePath: string) => ReadonlyArray<string>;
}>;

const RouterMethodNames = [
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'all',
] as const;
const RouterMethodLookup = new Set<string>(RouterMethodNames);

const CandidateFileGlobs = ['**/*.{ts,tsx,js,jsx,mjs,cjs}'] as const;

const RouteExcludeGlobs = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
] as const;

const DefaultExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

const normalizeFsPath = (value: string): string =>
  pipe(value, (candidate) => path.resolve(candidate), toPosix);

const collapseSlashes = (input: string): string => input.replace(/\/+?/gu, '/');

const normalizeHttpPath = (value: string): string => {
  const noQuery = value.split('?')[0]?.split('#')[0] ?? value;
  const withoutOrigin = noQuery.replace(/^https?:\/\/[^/]+/iu, '');
  const ensureLeading = withoutOrigin.startsWith('/') ? withoutOrigin : `/${withoutOrigin}`;
  const collapsed = collapseSlashes(ensureLeading);
  return collapsed === '' ? '/' : collapsed;
};

const joinHttpPaths = (parent: string, child: string): string => {
  const normalizedParent = parent === '/' ? '' : parent.replace(/\/+$/gu, '');
  const strippedChild = child === '/' ? '' : child.replace(/^\/+/, '');
  if (!normalizedParent && !strippedChild) {
    return '/';
  }
  if (!normalizedParent) {
    return collapseSlashes(`/${strippedChild}`);
  }
  if (!strippedChild) {
    const withLeading = normalizedParent.startsWith('/')
      ? normalizedParent
      : `/${normalizedParent}`;
    return collapseSlashes(withLeading);
  }
  const prefix = normalizedParent.startsWith('/') ? normalizedParent : `/${normalizedParent}`;
  return collapseSlashes(`${prefix}/${strippedChild}`);
};

const normalizeHttpSegments = (value: string): ReadonlyArray<string> =>
  normalizeHttpPath(value).split('/').filter(Boolean);

const expandHttpSearchTokens = (httpPath: string): ReadonlyArray<string> => {
  const normalized = normalizeHttpPath(httpPath);
  const tokens = new Set<string>([normalized]);

  const withoutParams = normalized.replace(/:[^/]+/g, '/');
  tokens.add(withoutParams);
  tokens.add(withoutParams.replace(/\/+$/, ''));

  const lastSlashIndex = normalized.lastIndexOf('/');
  if (lastSlashIndex > 0) {
    const base = normalized.slice(0, lastSlashIndex);
    tokens.add(base);
    tokens.add(`${base}/`);
  }

  return Array.from(tokens).filter((token) => token.length > 0);
};

const detectScriptKind = (filePath: string): ts.ScriptKind => {
  if (filePath.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith('.ts')) {
    return ts.ScriptKind.TS;
  }
  if (filePath.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.JS;
};

const createContainerRoutes = (): ContainerRoutes => ({ uses: [], handlers: [] });

const upsertContainerRoute = (
  map: Map<string, ContainerRoutes>,
  container: string,
  update: (existing: ContainerRoutes) => ContainerRoutes,
): void => {
  const current = map.get(container) ?? createContainerRoutes();
  map.set(container, update(current));
};

const collectBaseIdentifiers = (expr: ts.Expression): ReadonlyArray<string> => {
  if (ts.isIdentifier(expr)) {
    return [expr.text];
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return collectBaseIdentifiers(expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    return collectBaseIdentifiers(expr.expression);
  }
  if (ts.isCallExpression(expr)) {
    return pipe([expr.expression, ...expr.arguments], (nodes) =>
      nodes.flatMap((node) => collectBaseIdentifiers(node as ts.Expression)),
    );
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return pipe(expr.elements, (elements) =>
      elements.flatMap((el) => collectBaseIdentifiers(el as ts.Expression)),
    );
  }
  if (ts.isParenthesizedExpression(expr)) {
    return collectBaseIdentifiers(expr.expression);
  }
  return [];
};

const extractInlineRequireDescriptors = (expr: ts.Expression): ReadonlyArray<ImportDescriptor> => {
  if (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === 'require' &&
    expr.arguments.length > 0
  ) {
    const spec = readStringLiteralText(expr.arguments[0]);
    if (!spec) {
      return [];
    }
    const local = `__hl_inline_require_${spec}`;
    return [{ local, specifier: spec }];
  }
  if (ts.isCallExpression(expr)) {
    return pipe([expr.expression, ...expr.arguments], (nodes) =>
      nodes.flatMap((node) => extractInlineRequireDescriptors(node as ts.Expression)),
    );
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return extractInlineRequireDescriptors(expr.expression);
  }
  if (ts.isElementAccessExpression(expr)) {
    return extractInlineRequireDescriptors(expr.expression);
  }
  if (ts.isParenthesizedExpression(expr)) {
    return extractInlineRequireDescriptors(expr.expression);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    return pipe(expr.elements, (elements) =>
      elements.flatMap((el) => extractInlineRequireDescriptors(el as ts.Expression)),
    );
  }
  return [];
};

const exportedRouterIdentifierFromExpression = (expr: ts.Expression): string | undefined => {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isParenthesizedExpression(expr)) {
    return exportedRouterIdentifierFromExpression(expr.expression);
  }
  if (ts.isArrowFunction(expr)) {
    if (ts.isIdentifier(expr.body)) {
      return expr.body.text;
    }
    if (ts.isBlock(expr.body)) {
      const returns = expr.body.statements.filter(ts.isReturnStatement);
      const first = returns[0];
      const returned = first?.expression;
      return returned && ts.isIdentifier(returned) ? returned.text : undefined;
    }
    return undefined;
  }
  if (ts.isFunctionExpression(expr)) {
    const body = expr.body;
    const returns = body.statements.filter(ts.isReturnStatement);
    const first = returns[0];
    const returned = first?.expression;
    return returned && ts.isIdentifier(returned) ? returned.text : undefined;
  }
  return undefined;
};

const analyzeRouteFile = async (filePath: string): Promise<FileRouteInfo> => {
  const sourceText = await fs.readFile(filePath, 'utf8');
  const source = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    detectScriptKind(filePath),
  );

  const routerContainers = new Set<string>();
  const appContainers = new Set<string>();
  const containerRoutes = new Map<string, ContainerRoutes>();
  const importDescriptors: ImportDescriptor[] = [];
  const requireDescriptors: ImportDescriptor[] = [];
  let exportsRouter = false;

  const recordRouterFactory = (
    identifier: ts.Identifier | undefined,
    initializer: ts.CallExpression,
  ) => {
    if (!identifier) {
      return;
    }
    const callee = initializer.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const baseText = callee.expression.getText(source);
      if (baseText === 'express' && callee.name.text === 'Router') {
        routerContainers.add(identifier.text);
      }
    } else if (ts.isIdentifier(callee)) {
      if (callee.text === 'Router') {
        routerContainers.add(identifier.text);
      }
      if (callee.text === 'express') {
        appContainers.add(identifier.text);
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      recordRouterFactory(node.name as ts.Identifier, node.initializer);
      if (
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === 'express'
      ) {
        appContainers.add((node.name as ts.Identifier).text);
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'require' &&
      node.initializer.arguments.length > 0 &&
      ts.isStringLiteral(node.initializer.arguments[0])
    ) {
      const specifier = readStringLiteralText(node.initializer.arguments[0]) ?? '';
      if (ts.isIdentifier(node.name)) {
        const localName = readIdentifierText(node.name);
        if (localName) {
          requireDescriptors.push({ local: localName, specifier });
        }
      }
      if (ts.isObjectBindingPattern(node.name)) {
        node.name.elements.forEach((el) => {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            const localName = readIdentifierText(el.name) ?? '';
            if (localName.trim().length > 0) {
              requireDescriptors.push({ local: localName, specifier });
            }
          }
        });
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if (
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === 'module' &&
        node.left.name.text === 'exports'
      ) {
        const exported = exportedRouterIdentifierFromExpression(node.right);
        if (exported && routerContainers.has(exported)) {
          exportsRouter = true;
        }
      }
      if (
        ts.isPropertyAccessExpression(node.left) &&
        ts.isPropertyAccessExpression(node.left.expression) &&
        ts.isIdentifier(node.left.expression.expression) &&
        node.left.expression.expression.text === 'module' &&
        node.left.expression.name.text === 'exports'
      ) {
        const exported = exportedRouterIdentifierFromExpression(node.right);
        if (exported && routerContainers.has(exported)) {
          exportsRouter = true;
        }
      }
      if (
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === 'exports'
      ) {
        const exported = exportedRouterIdentifierFromExpression(node.right);
        if (exported && routerContainers.has(exported)) {
          exportsRouter = true;
        }
      }
    }

    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      if (clause) {
        if (clause.name) {
          importDescriptors.push({
            local: readIdentifierText(clause.name) ?? '',
            specifier: readStringLiteralText(node.moduleSpecifier) ?? '',
          });
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          clause.namedBindings.elements.forEach((element) => {
            const localName =
              readModuleExportNameText(element.propertyName) ??
              readIdentifierText(element.name) ??
              '';
            importDescriptors.push({
              local: localName,
              specifier: readStringLiteralText(node.moduleSpecifier) ?? '',
            });
          });
        }
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          importDescriptors.push({
            local: readIdentifierText(clause.namedBindings.name) ?? '',
            specifier: readStringLiteralText(node.moduleSpecifier) ?? '',
          });
        }
      }
    }

    if (ts.isExportAssignment(node)) {
      const exported = exportedRouterIdentifierFromExpression(node.expression);
      if (exported && routerContainers.has(exported)) {
        exportsRouter = true;
      }
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression.expression;
      if (!ts.isIdentifier(callee)) {
        ts.forEachChild(node, visit);
        return;
      }
      const container = callee.text;
      const method = node.expression.name.text;
      if (method === 'use' || RouterMethodLookup.has(method)) {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isCallExpression(node.expression.expression)) {
          ts.forEachChild(node, visit);
          return;
        }
        if (method === 'use') {
          const hasBasePath = Boolean(firstArg && ts.isStringLiteral(firstArg));
          const pathLiteral = hasBasePath ? (firstArg as ts.StringLiteral).text : '/';
          const argsForTargets = hasBasePath ? node.arguments.slice(1) : node.arguments;
          const identifiers = pipe(argsForTargets, (args) =>
            args.flatMap((arg) => collectBaseIdentifiers(arg)),
          );
          const inlineRequires = pipe(argsForTargets, (args) =>
            args.flatMap((arg) => extractInlineRequireDescriptors(arg)),
          );
          inlineRequires.forEach((desc) => requireDescriptors.push(desc));
          const inlineTargets = inlineRequires.map((d) => d.local);
          upsertContainerRoute(containerRoutes, container, (existing) => ({
            uses: [
              ...existing.uses,
              {
                path: pathLiteral,
                targets: [...identifiers, ...inlineTargets],
                container,
              },
            ],
            handlers: existing.handlers,
          }));
        } else if (RouterMethodLookup.has(method)) {
          if (!firstArg || !ts.isStringLiteral(firstArg)) {
            ts.forEachChild(node, visit);
            return;
          }
          const pathLiteral = firstArg.text;
          const restArgs = node.arguments.slice(1);
          const identifiers = pipe(restArgs, (args) =>
            args.flatMap((arg) => collectBaseIdentifiers(arg)),
          );
          upsertContainerRoute(containerRoutes, container, (existing) => ({
            uses: existing.uses,
            handlers: [
              ...existing.handlers,
              {
                method,
                path: pathLiteral,
                identifiers,
                container,
              },
            ],
          }));
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  const resolvedImports = await resolveImportMap(filePath, [
    ...importDescriptors,
    ...requireDescriptors,
  ]);

  const containersWithRoutes = new Map(
    [...containerRoutes.entries()].filter(
      ([key]) => routerContainers.has(key) || appContainers.has(key),
    ),
  );

  return {
    filePath,
    imports: resolvedImports,
    routerContainers,
    appContainers,
    containerRoutes: containersWithRoutes,
    exportsRouter,
  };
};

const resolveImportMap = async (
  fromFile: string,
  descriptors: ReadonlyArray<ImportDescriptor>,
): Promise<ReadonlyMap<string, string>> => {
  const resolveCache = new Map<string, Promise<string | undefined>>();
  const resolveSpecifier = (specifier: string): Promise<string | undefined> => {
    const cacheKey = `${fromFile}::${specifier}`;
    if (resolveCache.has(cacheKey)) {
      return resolveCache.get(cacheKey) as Promise<string | undefined>;
    }
    const task = resolveImportSpecifier(fromFile, specifier).catch(() => undefined);
    resolveCache.set(cacheKey, task);
    return task;
  };

  const entries = await Promise.all(
    descriptors.map(async (descriptor) => {
      const resolved = await resolveSpecifier(descriptor.specifier);
      return resolved ? ([descriptor.local, resolved] as const) : undefined;
    }),
  );

  return new Map(entries.filter((entry): entry is readonly [string, string] => Boolean(entry)));
};

const resolveImportSpecifier = async (
  fromFile: string,
  specifier: string,
): Promise<string | undefined> => {
  if (/^(?:node:|[a-z]+:)/i.test(specifier)) {
    return undefined;
  }
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return undefined;
  }
  const base = specifier.startsWith('.')
    ? path.resolve(path.dirname(fromFile), specifier)
    : path.resolve(specifier);
  const candidates = buildResolutionCandidates(base);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, FsConstants.R_OK);
      return normalizeFsPath(candidate);
    } catch {
      // continue searching
    }
  }
  return undefined;
};

const buildResolutionCandidates = (base: string): ReadonlyArray<string> => {
  const normalized = normalizeFsPath(base);
  const hasExtension = DefaultExtensions.some((ext) => normalized.endsWith(ext));
  const baseCandidates = hasExtension
    ? [normalized]
    : DefaultExtensions.map((ext) => `${normalized}${ext}`);
  const directoryCandidates = DefaultExtensions.map((ext) => path.join(normalized, `index${ext}`));
  return [...(hasExtension ? [] : [normalized]), ...baseCandidates, ...directoryCandidates];
};

const listRouteCandidateFiles = async (repoRoot: string): Promise<ReadonlyArray<string>> => {
  const raw = await ripgrepSearch(
    ['router\\.use\\(', 'app\\.use\\(', 'router\\.(get|post|put|delete|patch|options|head|all)\\('],
    CandidateFileGlobs,
    RouteExcludeGlobs,
    repoRoot,
    { filesWithMatches: true },
  );
  return pipe(
    raw.split(/\r?\n/),
    (lines) =>
      lines
        .map((line) => line.trim())
        .filter(Boolean)
        .map((candidate) =>
          normalizeFsPath(path.isAbsolute(candidate) ? candidate : path.join(repoRoot, candidate)),
        ),
    (paths) => Array.from(new Set(paths)),
  );
};

const ensureContainerRoutes = (
  info: FileRouteInfo,
  containers: ReadonlySet<string>,
): ReadonlyArray<ContainerRoutes> =>
  Array.from(containers)
    .map((container) => info.containerRoutes.get(container))
    .filter((value): value is ContainerRoutes => Boolean(value));

const buildRouteIndexInternal = async (repoRoot: string): Promise<RouteIndex> => {
  const candidateFiles = await listRouteCandidateFiles(repoRoot);
  const fileInfos = await Promise.all(candidateFiles.map((filePath) => analyzeRouteFile(filePath)));
  const infoByPath = new Map(fileInfos.map((info) => [info.filePath, info] as const));

  const routerFiles = new Set(
    fileInfos.filter((info) => info.exportsRouter).map((info) => info.filePath),
  );

  type QueueEntry = Readonly<{
    readonly filePath: string;
    readonly basePath: string;
    readonly kind: 'app' | 'router';
  }>;

  const visited = new Set<string>();
  const queue: QueueEntry[] = pipe(fileInfos, (infos) =>
    infos
      .filter((info) => info.appContainers.size > 0)
      .map((info) => ({ filePath: info.filePath, basePath: '/', kind: 'app' }) as QueueEntry)
      .concat(
        infos
          .filter((info) => info.exportsRouter)
          .map(
            (info) => ({ filePath: info.filePath, basePath: '/', kind: 'router' }) as QueueEntry,
          ),
      ),
  );

  const httpRouteToSources = new Map<string, Map<string, Set<string>>>();
  const sourceToHttpRoutes = new Map<string, Set<string>>();

  const enqueue = (entry: QueueEntry): void => {
    queue.push(entry);
  };

  const addSourceMapping = (httpPath: string, sourcePath: string, method: string): void => {
    const normalizedHttp = normalizeHttpPath(httpPath);
    const normalizedMethod = method.toUpperCase();
    const normalizedSource = normalizeFsPath(sourcePath);
    const perMethod = httpRouteToSources.get(normalizedHttp) ?? new Map<string, Set<string>>();
    const sourceSet = perMethod.get(normalizedMethod) ?? new Set<string>();
    sourceSet.add(normalizedSource);
    perMethod.set(normalizedMethod, sourceSet);
    httpRouteToSources.set(normalizedHttp, perMethod);

    const routesForSource = sourceToHttpRoutes.get(normalizedSource) ?? new Set<string>();
    routesForSource.add(normalizedHttp);
    sourceToHttpRoutes.set(normalizedSource, routesForSource);
  };

  const processHandlers = (
    info: FileRouteInfo,
    containers: ReadonlyArray<ContainerRoutes>,
    basePath: string,
  ): void => {
    containers.forEach((container) => {
      container.handlers.forEach((handler) => {
        const absolutePath = joinHttpPaths(basePath, handler.path);
        const identifiedHandlers = handler.identifiers
          .map((identifier) => info.imports.get(identifier))
          .filter((candidate): candidate is string => Boolean(candidate));
        const sources = Array.from(
          new Set(
            identifiedHandlers.length === 0
              ? [info.filePath]
              : [info.filePath, ...identifiedHandlers],
          ),
        ).map((candidate) => normalizeFsPath(candidate));
        sources.forEach((sourcePath) => addSourceMapping(absolutePath, sourcePath, handler.method));
      });
    });
  };

  const resolveChildRouters = (
    info: FileRouteInfo,
    containers: ReadonlyArray<ContainerRoutes>,
    basePath: string,
  ): ReadonlyArray<QueueEntry> =>
    containers.flatMap((container) =>
      container.uses.flatMap((use) =>
        use.targets
          .map((target) => info.imports.get(target))
          .filter((candidate): candidate is string => Boolean(candidate))
          .filter((candidate) => routerFiles.has(candidate))
          .map((candidate) => ({
            filePath: candidate,
            basePath: joinHttpPaths(basePath, use.path),
            kind: 'router' as const,
          })),
      ),
    );

  while (queue.length > 0) {
    const current = queue.shift() as QueueEntry;
    const key = `${current.filePath}::${current.basePath}::${current.kind}`;
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    const info = infoByPath.get(current.filePath);
    if (!info) {
      continue;
    }
    const containers = ensureContainerRoutes(
      info,
      current.kind === 'app' ? info.appContainers : info.routerContainers,
    );
    if (containers.length === 0) {
      continue;
    }
    processHandlers(info, containers, current.basePath);
    const children = resolveChildRouters(info, containers, current.basePath);
    children.forEach(enqueue);
  }

  const trie = Array.from(httpRouteToSources.entries()).reduce(
    (tree, [httpPath, setByMethod]) =>
      Array.from(setByMethod.entries()).reduce(
        (innerTree, [method, sources]) =>
          insertRoute(innerTree, normalizeHttpSegments(httpPath), method, Array.from(sources)),
        tree,
      ),
    emptyRouteTrie<ReadonlyArray<string>>(),
  );

  return {
    sourcesForHttpRoute: (httpPath: string) => {
      const segments = normalizeHttpSegments(httpPath);
      const methodsToSearch = [...RouterMethodNames.map((method) => method.toUpperCase()), '*'];
      const matches = methodsToSearch.flatMap((method) =>
        collectRouteHandlers(trie, segments, method),
      );
      return matches.length > 0
        ? Array.from(new Set(matches.flatMap((sources) => sources.map((p) => normalizeFsPath(p)))))
        : [];
    },
    httpRoutesForSource: (sourcePath: string) => {
      const normalizedSource = normalizeFsPath(sourcePath);
      const entry = sourceToHttpRoutes.get(normalizedSource);
      const routes = entry ? Array.from(entry) : [];
      return routes;
    },
  };
};

const routeIndexCache = new Map<string, Promise<RouteIndex>>();

export const getRouteIndex = async (repoRoot: string): Promise<RouteIndex> => {
  const normalizedRoot = normalizeFsPath(repoRoot);
  const cached = routeIndexCache.get(normalizedRoot);
  if (cached) {
    return cached;
  }
  const task = buildRouteIndexInternal(normalizedRoot).catch((err) => {
    routeIndexCache.delete(normalizedRoot);
    throw err;
  });
  routeIndexCache.set(normalizedRoot, task);
  return task;
};

export const resolveSourcesForHttpRoutes = async (
  repoRoot: string,
  httpPaths: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  if (httpPaths.length === 0) {
    return [];
  }
  const index = await getRouteIndex(repoRoot);
  const resolved = httpPaths.flatMap((httpPath) => index.sourcesForHttpRoute(httpPath));
  return Array.from(new Set(resolved.map((filePath) => normalizeFsPath(filePath))));
};

export const discoverTestsForHttpPaths = async (
  repoRoot: string,
  httpPaths: ReadonlyArray<string>,
  excludeGlobs: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  if (httpPaths.length === 0) {
    return [];
  }
  const searchTokens = Array.from(
    new Set(httpPaths.flatMap((candidate) => expandHttpSearchTokens(candidate))),
  );
  if (searchTokens.length === 0) {
    return [];
  }
  const search = await ripgrepSearch(searchTokens, DEFAULT_TEST_GLOBS, excludeGlobs, repoRoot, {
    filesWithMatches: true,
    fixedStrings: true,
  });
  const results = pipe(
    search.split(/\r?\n/),
    (lines) =>
      lines
        .map((line) => line.trim())
        .filter(Boolean)
        .map((match) =>
          normalizeFsPath(path.isAbsolute(match) ? match : path.join(repoRoot, match)),
        ),
    (paths) => Array.from(new Set(paths)),
  );
  return results;
};
