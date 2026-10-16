
"use client";

/**
 * Recursively removes properties with `undefined` values from an object or array.
 * Firestore does not support `undefined` and will throw an error.
 * This utility cleans the object before it's sent to Firestore.
 * @param obj The object or array to clean.
 * @returns A new object or array with `undefined` properties removed.
 */
export function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    // For arrays, filter out undefined values and recurse on elements.
    return (obj as any[])
      .filter(item => item !== undefined)
      .map(item => stripUndefined(item)) as T;
  }

  if (typeof obj !== 'object' || obj instanceof Date) {
    // Return primitives, Dates, and other non-plain-objects as is.
    // Firestore Timestamps are objects but should not be recursed into.
    // A simple typeof check is sufficient for most cases.
    return obj;
  }
  
  // It's a plain object, so we recurse on its properties.
  const newObj: { [key: string]: any } = {};
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = (obj as any)[key];
      if (value !== undefined) {
        newObj[key] = stripUndefined(value); // Recurse
      }
    }
  }

  return newObj as T;
}
