export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, ti = 0, score = 0, last = -2;
  for (; qi < q.length && ti < t.length; ti++) {
    if (q[qi] === t[ti]) {
      // bonus for contiguous + start-of-word
      score += (ti === last + 1 ? 2 : 1);
      if (ti === 0 || t[ti-1] === "/" || t[ti-1] === "-" || t[ti-1] === "_") score += 2;
      last = ti; qi++;
    }
  }
  if (qi !== q.length) return null;
  // penalize longer targets slightly
  score -= Math.floor(t.length / 20);
  return score;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t:T)=>string): T[] {
  if (!query.trim()) return items;
  const scored = items.map(i => ({ i, s: fuzzyScore(query, key(i)) }))
    .filter(x => x.s !== null) as Array<{i:T; s:number}>;
  scored.sort((a,b)=> b.s - a.s);
  return scored.map(x=>x.i);
}
