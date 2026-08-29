const PAGE_SIZE = 1000;

/**
 * O Supabase/PostgREST limita cada select a 1000 linhas por padrão. Qualquer
 * consulta que possa retornar mais que isso (ex.: um mês inteiro de
 * movimentações) precisa paginar com .range() até esgotar os resultados —
 * caso contrário os dados são truncados silenciosamente.
 */
export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  let todas: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error || !data) break;
    todas = todas.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return todas;
}

/**
 * Para consultas com .in("coluna", ids) sobre uma lista de ids potencialmente
 * grande: divide em lotes (evita URLs enormes) e pagina cada lote.
 */
export async function fetchAllByIds<T>(
  ids: string[],
  buildQuery: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  chunkSize = 200
): Promise<T[]> {
  let todas: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const rows = await fetchAllRows<T>((from, to) => buildQuery(chunk, from, to));
    todas = todas.concat(rows);
  }
  return todas;
}
