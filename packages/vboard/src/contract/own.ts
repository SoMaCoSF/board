// Board state keys plain objects by names people choose, and `constructor` or
// `__proto__` is a valid emoji, handle, label, or channel. A null prototype
// doesn't survive A2's structuredClone or a JSON snapshot, so reads check
// ownership and writes define the key instead of assigning it.

/** `dict[key]`, never an Object.prototype property. */
export const own = <T>(dict: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(dict, key) ? dict[key] : undefined

/** `dict[key] = value`, even when `key` is `__proto__`. */
export function put<T>(dict: Record<string, T>, key: string, value: T): T {
  Object.defineProperty(dict, key, { value, writable: true, enumerable: true, configurable: true })
  return value
}
