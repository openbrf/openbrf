/**
 * A CSV the server produced, as a link a browser will save.
 *
 * Made from the bytes already in the page: the file comes back on the audited
 * request that produced it, so following the link fetches nothing more.
 */
export function fileHref(csv: string): string {
  return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
}
