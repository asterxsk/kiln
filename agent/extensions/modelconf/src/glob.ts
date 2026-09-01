export function globToRegExp(pattern: string): RegExp {
  let p = pattern;
  if (!p.includes("*") && !p.includes("?")) p = `*${p}*`;
  const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}
export function matchesGlob(input: string, pattern: string): boolean {
  return globToRegExp(pattern).test(input);
}
export function filterByGlob<T>(pattern: string, items: T[], key:(t:T)=>string): T[] {
  const rx = globToRegExp(pattern);
  return items.filter(i => rx.test(key(i)));
}
