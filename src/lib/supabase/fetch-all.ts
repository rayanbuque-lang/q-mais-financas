const PAGE_SIZE = 1000;
// Trava de segurança contra um loop infinito se o servidor devolver páginas
// não vazias sem nunca esgotar (não deveria acontecer) — 500 páginas de 1000
// já são 500 mil linhas, bem acima de qualquer uso real deste app.
const MAX_PAGINAS = 500;

/**
 * O Supabase/PostgREST tem um teto de linhas por requisição (o valor exato
 * depende da configuração "Max Rows" de cada projeto — não pressupor 1000).
 * Qualquer consulta que possa passar desse teto precisa paginar com .range()
 * até esgotar os resultados, senão os dados são truncados silenciosamente.
 *
 * Avança sempre por `data.length` (não por PAGE_SIZE) e só para quando uma
 * página vem vazia — assim funciona corretamente mesmo que o teto real do
 * projeto seja diferente de PAGE_SIZE.
 */
export async function fetchAllRows<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<T[]> {
  const { data } = await fetchAllRowsSafe(buildQuery);
  return data;
}

/**
 * Igual a fetchAllRows, mas devolve o erro em vez de engoli-lo. Use quando
 * quem chama precisa distinguir "não achou nada" de "a busca falhou" -- ex.:
 * uma checagem contra duplicidade/baixa automática não pode tratar uma falha
 * de rede como "zero contas encontradas", ou libera algo que na verdade nunca
 * foi conferido contra nada.
 */
export async function fetchAllRowsSafe<T>(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
): Promise<{ data: T[]; error: unknown | null; truncado: boolean }> {
  let todas: T[] = [];
  let from = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) return { data: todas, error, truncado: false };
    if (!data || data.length === 0) return { data: todas, error: null, truncado: false };
    todas = todas.concat(data);
    from += data.length;
  }
  // Só chega aqui se MAX_PAGINAS páginas vieram todas cheias -- sinaliza pra
  // quem chama que pode haver mais dados além do que foi trazido, em vez de
  // fingir que esgotou.
  return { data: todas, error: null, truncado: true };
}

/**
 * Para consultas com .in("coluna", ids) sobre uma lista de ids potencialmente
 * grande: divide em lotes (evita URLs enormes) e pagina cada lote.
 *
 * Retorna o erro (se houver) em vez de engoli-lo, porque um resultado parcial
 * tratado como "está tudo" pode ser pior que não atualizar nada — ex.: um mapa
 * de itens incompleto pode levar quem chama a apagar itens reais ao salvar.
 */
export async function fetchAllByIds<T>(
  ids: string[],
  buildQuery: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  chunkSize = 200
): Promise<{ data: T[]; error: unknown | null }> {
  let todas: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    let from = 0;
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      const { data, error } = await buildQuery(chunk, from, from + PAGE_SIZE - 1);
      if (error) return { data: todas, error };
      if (!data || data.length === 0) break;
      todas = todas.concat(data);
      from += data.length;
    }
  }
  return { data: todas, error: null };
}
