/** Same-protocol package copies share weak identity tables, never connection ownership. */
export function sharedWeakMap<K extends object, V>(name: string): WeakMap<K, V> {
  const key = Symbol.for(`@kequtech/pgclear/identity/v1/${name}`);
  const shared = globalThis as typeof globalThis & { [key: symbol]: unknown };
  if (shared[key] === undefined) Object.defineProperty(shared, key, { value: new WeakMap<K, V>() });
  return shared[key] as WeakMap<K, V>;
}
