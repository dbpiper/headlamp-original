// Minimal Haskell-style toolkit (no effects, all named exports)
export type Fn<A, B> = (a: A) => B;

// Heteromorphic pipe: allows A -> B -> C ... with overloads
export function pipe<A>(a: A): A;
export function pipe<A, B>(a: A, ab: Fn<A, B>): B;
export function pipe<A, B, C>(a: A, ab: Fn<A, B>, bc: Fn<B, C>): C;
export function pipe<A, B, C, D>(a: A, ab: Fn<A, B>, bc: Fn<B, C>, cd: Fn<C, D>): D;
export function pipe<A, B, C, D, E>(
  a: A,
  ab: Fn<A, B>,
  bc: Fn<B, C>,
  cd: Fn<C, D>,
  de: Fn<D, E>,
): E;
export function pipe<A, B, C, D, E, F>(
  a: A,
  ab: Fn<A, B>,
  bc: Fn<B, C>,
  cd: Fn<C, D>,
  de: Fn<D, E>,
  ef: Fn<E, F>,
): F;
export function pipe(initial: unknown, ...fns: ReadonlyArray<Fn<unknown, unknown>>): unknown {
  return fns.reduce((acc, fn) => fn(acc), initial);
}

export function flow<A, B>(ab: Fn<A, B>): Fn<A, B>;
export function flow<A, B, C>(ab: Fn<A, B>, bc: Fn<B, C>): Fn<A, C>;
export function flow<A, B, C, D>(ab: Fn<A, B>, bc: Fn<B, C>, cd: Fn<C, D>): Fn<A, D>;
export function flow<A, B, C, D, E>(
  ab: Fn<A, B>,
  bc: Fn<B, C>,
  cd: Fn<C, D>,
  de: Fn<D, E>,
): Fn<A, E>;
export function flow(...fns: ReadonlyArray<Fn<unknown, unknown>>) {
  return (input: unknown) => fns.reduce((acc, fn) => fn(acc), input);
}

export type Option<A> = { readonly tag: 'Some'; readonly value: A } | { readonly tag: 'None' };
export const some = <A>(value: A): Option<A> => ({ tag: 'Some', value });
export const none: Option<never> = { tag: 'None' };
export const fromNullable = <A>(value: A | null | undefined): Option<A> =>
  value == null ? none : some(value);
export const mapOption =
  <A, B>(mapFn: (input: A) => B) =>
  (option: Option<A>): Option<B> =>
    option.tag === 'Some' ? some(mapFn(option.value)) : none;
export const flatMapOption =
  <A, B>(bindFn: (input: A) => Option<B>) =>
  (option: Option<A>): Option<B> =>
    option.tag === 'Some' ? bindFn(option.value) : none;
export const getOrElseOption =
  <A>(onNone: () => A) =>
  (option: Option<A>): A =>
    option.tag === 'Some' ? option.value : onNone();

export type Result<E, A> =
  | { readonly tag: 'Ok'; readonly value: A }
  | { readonly tag: 'Err'; readonly error: E };
export const ok = <A>(value: A): Result<never, A> => ({ tag: 'Ok', value });
export const err = <E>(error: E): Result<E, never> => ({ tag: 'Err', error });
export const mapResult =
  <E, A, B>(mapFn: (input: A) => B) =>
  (result: Result<E, A>): Result<E, B> =>
    result.tag === 'Ok' ? ok(mapFn(result.value)) : result;
export const flatMapResult =
  <E, A, B>(bindFn: (input: A) => Result<E, B>) =>
  (result: Result<E, A>): Result<E, B> =>
    result.tag === 'Ok' ? bindFn(result.value) : result;

export const unfoldr = <S, A>(
  initial: S,
  step: (state: S) => Option<readonly [A, S]>,
): ReadonlyArray<A> => {
  const out: A[] = [];
  // eslint-disable-next-line no-constant-condition
  for (let state = initial; ; ) {
    const result = step(state);
    if (result.tag === 'None') {
      break;
    }
    const [element, next] = result.value;
    out.push(element);
    state = next;
  }
  return out;
};
