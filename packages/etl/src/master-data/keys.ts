/**
 * T-391 S2 - name keys. `key` is the exact identity (T-145's own unique index says "Pork Belly" and "pork belly " are
 * one item). `loose` is used ONLY to DETECT near-duplicates, never to merge them: "Coke 1.5" and "Coke 15" share a
 * loose key and are still two different products. `isJunkName` is q5-5 / R14: under two characters, or no letter.
 */
export const key = (name: string): string => name.trim().toLowerCase();

export const loose = (name: string): string => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');

export const isJunkName = (name: string): boolean => {
  const t = name.trim();
  return t.length < 2 || !/[a-z]/i.test(t);
};
