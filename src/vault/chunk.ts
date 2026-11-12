/**
 * Cut a body into a chunk starting at `offset`, at most `max` chars, preferring
 * to end on a line break (within the last 20% of the chunk) so a reader never
 * gets half a line. Returns next=null when the chunk reaches the end.
 */
export function sliceBody(
  body: string,
  offset: number,
  max: number,
): { body: string; offset: number; next: number | null; total: number } {
  const total = body.length;
  const start = Math.min(Math.max(0, offset), total);
  let end = Math.min(start + max, total);
  if (end < total) {
    const nl = body.lastIndexOf("\n", end - 1);
    if (nl >= start + Math.floor(max * 0.8)) end = nl + 1;
  }
  return { body: body.slice(start, end), offset: start, next: end < total ? end : null, total };
}

/**
 * Page through a list: start at `offset`, take at most `limit` items, and stop
 * early once the pretty-printed JSON of the page would exceed `charBudget`
 * (always returns at least one item when any remain). next=null at the end.
 */
export function paginate<T>(
  items: T[],
  offset: number,
  limit: number,
  charBudget: number,
): { items: T[]; offset: number; next: number | null; total: number } {
  const total = items.length;
  const start = Math.min(Math.max(0, offset), total);
  const page: T[] = [];
  let used = 0;
  for (const item of items.slice(start)) {
    if (page.length >= limit) break;
    const cost = JSON.stringify(item, null, 2).length + 8; // + indentation/comma overhead
    if (page.length > 0 && used + cost > charBudget) break;
    page.push(item);
    used += cost;
  }
  const end = start + page.length;
  return { items: page, offset: start, next: end < total ? end : null, total };
}
