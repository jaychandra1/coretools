/**
 * Object keys that come from documents — JSON, YAML, CSV headers, workbook
 * columns — can be anything, including "__proto__" or "constructor". These
 * keep such keys as ordinary data: a plain `obj[key] = value` with key
 * "__proto__" would replace the object's prototype and drop the key, and
 * `key in obj` would see inherited properties as present.
 */

/** Set `key` as the object's own property, whatever its name. */
export function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** `key` is the object's own property (inherited ones don't count). */
export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}
