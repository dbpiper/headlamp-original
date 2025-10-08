export type RouteTrieNode<A> = Readonly<{
  readonly segment: string;
  readonly kind: 'literal' | 'param' | 'splat';
  readonly paramName?: string;
  readonly handlers: ReadonlyMap<string, A>;
  readonly children: ReadonlyArray<RouteTrieNode<A>>;
}>;

const EmptyChildren = Object.freeze([]) as ReadonlyArray<never>;
const EmptyHandlers = Object.freeze(new Map<string, never>()) as ReadonlyMap<string, never>;

const mkNode = <A>(
  segment: string,
  kind: 'literal' | 'param' | 'splat',
  paramName: string | undefined,
  handlers: ReadonlyMap<string, A>,
  children: ReadonlyArray<RouteTrieNode<A>>,
): RouteTrieNode<A> => ({
  segment,
  kind,
  ...(paramName ? { paramName } : {}),
  handlers,
  children,
});

const upsertHandler = <A>(
  handlers: ReadonlyMap<string, A>,
  method: string,
  value: A,
): ReadonlyMap<string, A> => {
  const next = new Map(handlers);
  next.set(method.toUpperCase(), value);
  return next;
};

const isWildcard = (segment: string): boolean => segment === '*';
const isParam = (segment: string): boolean => segment.startsWith(':');

const classifySegment = (
  segment: string,
): {
  readonly kind: 'literal' | 'param' | 'splat';
  readonly paramName?: string;
} => {
  if (isWildcard(segment)) {
    return { kind: 'splat' };
  }
  if (isParam(segment)) {
    return { kind: 'param', paramName: segment.slice(1) };
  }
  return { kind: 'literal' };
};

const appendIfPresent = <A>(items: ReadonlyArray<A>, candidate: A | undefined): ReadonlyArray<A> =>
  candidate === undefined ? items : [...items, candidate];

type Match<A> = Readonly<{
  readonly handlers: ReadonlyArray<A>;
  readonly matched: number;
  readonly priority: number;
}>;

const preferMatch = <A>(current: Match<A>, candidate: Match<A>): Match<A> => {
  if (candidate.matched > current.matched) {
    return candidate;
  }
  if (candidate.matched === current.matched && candidate.priority < current.priority) {
    return candidate;
  }
  return current;
};

const collectHandlers = <A>(
  node: RouteTrieNode<A>,
  segments: ReadonlyArray<string>,
  method: string,
  accumulated: ReadonlyArray<A>,
): Match<A> => {
  const methodKey = method.toUpperCase();
  const methodSpecific = node.handlers.get(methodKey);
  const wildcard = methodSpecific === undefined ? node.handlers.get('*') : undefined;
  const currentHandlers = appendIfPresent(appendIfPresent(accumulated, methodSpecific), wildcard);

  if (segments.length === 0) {
    return { handlers: currentHandlers, matched: 0, priority: Number.POSITIVE_INFINITY };
  }

  const [head, ...tail] = segments;
  const literalMatches = node.children
    .filter((child) => child.kind === 'literal' && child.segment === head)
    .map((child) => collectHandlers(child, tail, method, currentHandlers))
    .map(
      (match) =>
        ({ handlers: match.handlers, matched: match.matched + 1, priority: 0 }) as Match<A>,
    );

  const paramMatches = node.children
    .filter((child) => child.kind === 'param')
    .map((child) => collectHandlers(child, tail, method, currentHandlers))
    .map(
      (match) =>
        ({ handlers: match.handlers, matched: match.matched + 1, priority: 1 }) as Match<A>,
    );

  const splatMatches = node.children
    .filter((child) => child.kind === 'splat')
    .map((child) => collectHandlers(child, [], method, currentHandlers))
    .map(
      (match) =>
        ({
          handlers: match.handlers,
          matched: match.matched + segments.length,
          priority: 2,
        }) as Match<A>,
    );

  const fallback: Match<A> = {
    handlers: currentHandlers,
    matched: 0,
    priority: Number.POSITIVE_INFINITY,
  };

  return [...literalMatches, ...paramMatches, ...splatMatches].reduce(preferMatch, fallback);
};

export type RouteTrie<A> = Readonly<{
  readonly root: RouteTrieNode<A>;
}>;

export const emptyRouteTrie = <A>(): RouteTrie<A> => ({
  root: mkNode('', 'literal', undefined, EmptyHandlers, EmptyChildren),
});

export const collectRouteHandlers = <A>(
  trie: RouteTrie<A>,
  segments: ReadonlyArray<string>,
  method: string,
): ReadonlyArray<A> => collectHandlers(trie.root, segments, method, []).handlers;

const insertSegments = <A>(
  node: RouteTrieNode<A>,
  segments: ReadonlyArray<string>,
  method: string,
  value: A,
): RouteTrieNode<A> => {
  if (segments.length === 0) {
    return mkNode(
      node.segment,
      node.kind,
      node.paramName,
      upsertHandler(node.handlers, method, value),
      node.children,
    );
  }
  const [head, ...tail] = segments;
  const { kind, paramName } = classifySegment(head);
  const matcher = (candidate: RouteTrieNode<A>): boolean => {
    if (candidate.kind !== kind) {
      return false;
    }
    if (kind === 'literal') {
      return candidate.segment === head;
    }
    if (kind === 'param') {
      return candidate.paramName === paramName;
    }
    return true;
  };
  const existing = node.children.find(matcher);
  const nextChild = existing
    ? insertSegments(existing, tail, method, value)
    : insertSegments(
        mkNode(head, kind, paramName, EmptyHandlers, EmptyChildren),
        tail,
        method,
        value,
      );
  const others = node.children.filter((child) => child !== existing);
  return mkNode(
    node.segment,
    node.kind,
    node.paramName,
    node.handlers,
    [...others, nextChild].sort((left, right) => {
      if (left.kind === right.kind) {
        return left.segment.localeCompare(right.segment);
      }
      const order = { literal: 0, param: 1, splat: 2 } as const;
      return order[left.kind] - order[right.kind];
    }),
  );
};

export const insertRoute = <A>(
  trie: RouteTrie<A>,
  segments: ReadonlyArray<string>,
  method: string,
  value: A,
): RouteTrie<A> => ({
  root: insertSegments(trie.root, segments, method, value),
});
