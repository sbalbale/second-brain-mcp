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
