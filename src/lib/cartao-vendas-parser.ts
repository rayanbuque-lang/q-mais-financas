// Parser dos relatórios de vendas da maquininha (.xlsx) para o módulo de
// conciliação de cartão. Mesma técnica de src/lib/relatorio-pix.ts: .xlsx é
// um .zip por dentro, reaproveita o extrator já existente (src/lib/zip.ts),
// sem nenhuma dependência nova.
//
// Layout real observado nos dois arquivos exportados pela adquirente
// ("Vendas_Detalhado_..." e "Vendas_Consolidado_..."):
// - Detalhado: abas CARTÕES/PIX/VOUCHER com uma linha por transação (tem
//   "NÚMERO DO COMPROVANTE DE VENDAS (CV)" -- é o que diferencia do Consolidado).
// - Consolidado: aba "CONSOLIDADO" + as mesmas abas, mas agregadas por
//   dia+bandeira+modalidade (tem "QUANTIDADE DE VENDAS", sem NSU).
// Ambos usam inlineStr (não sharedStrings) e cabeçalho fora da linha 1 (o
// arquivo tem um bloco de identificação do estabelecimento antes da tabela).

import { extrairArquivosZip, ZipParseError } from "@/lib/zip";

export class CartaoVendasParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartaoVendasParseError";
  }
}

export type OrigemPlanilha = "cartoes" | "pix" | "voucher";
export type ModalidadeCartao = "credito" | "debito" | "pix" | "voucher";
export type StatusTransacaoCartao = "aprovada" | "negada" | "estornada" | "paga" | "expirada";

export interface TransacaoCartao {
  origemPlanilha: OrigemPlanilha;
  bandeira: string;
  modalidade: ModalidadeCartao;
  formaPagamento: string | null;
  dataHoraVenda: string; // ISO 8601
  statusTransacao: StatusTransacaoCartao;
  parcelas: number;
  numeroCartaoMascarado: string | null;
  numeroAutorizacao: string | null;
  numeroComprovante: string | null;
  numeroTerminal: string | null;
  valorBruto: number;
  valorTaxa: number | null;
  valorLiquido: number | null;
  dataPrevistaPagamento: string | null; // yyyy-mm-dd
  dadosBrutos: Record<string, string | null>;
}

export interface ParseDetalhadoResult {
  transacoes: TransacaoCartao[];
  avisos: string[];
  totalLinhasLidas: number;
  periodoInicio: string | null;
  periodoFim: string | null;
}

export interface TotalConsolidado {
  origemPlanilha: OrigemPlanilha;
  bandeira: string;
  modalidade: string;
  totalBruto: number;
  totalTaxa: number | null;
  totalLiquido: number | null;
}

export interface ParseConsolidadoResult {
  totais: TotalConsolidado[];
  avisos: string[];
  periodoInicio: string | null;
  periodoFim: string | null;
}

interface CelulaBruta {
  ref: string;
  tipo: string | null;
  valor: string | null;
}

function extrairCelulas(linhaXml: string): CelulaBruta[] {
  const celulasXml = linhaXml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
  return celulasXml.map((celulaXml) => {
    const ref = celulaXml.match(/\br="([A-Z]+\d+)"/)?.[1] ?? "";
    const tipo = celulaXml.match(/\bt="([a-zA-Z]+)"/)?.[1] ?? null;
    if (tipo === "inlineStr") {
      const texto = [...celulaXml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("");
      return { ref, tipo, valor: decodificarEntidadesXml(texto) };
    }
    const valor = celulaXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? null;
    return { ref, tipo, valor };
  });
}

function extrairLinhas(sheetXml: string): CelulaBruta[][] {
  const linhasXml = sheetXml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) ?? [];
  return linhasXml.map(extrairCelulas);
}

function letraColuna(ref: string): string {
  return ref.match(/^[A-Z]+/)?.[0] ?? "";
}

function colunaParaIndice(letras: string): number {
  let indice = 0;
  for (const c of letras) indice = indice * 26 + (c.charCodeAt(0) - 64);
  return indice - 1;
}

function decodificarEntidadesXml(texto: string): string {
  return texto
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extrairStringsCompartilhadas(xml: string): string[] {
  const blocos = xml.match(/<si>[\s\S]*?<\/si>/g) ?? [];
  return blocos.map((bloco) => {
    const textos = [...bloco.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodificarEntidadesXml(m[1]));
    return textos.join("");
  });
}

function valorCelula(celula: CelulaBruta | undefined, sharedStrings: string[]): string | null {
  if (!celula || celula.valor === null) return null;
  if (celula.tipo === "s") {
    const indice = Number(celula.valor);
    return sharedStrings[indice] ?? null;
  }
  return celula.valor;
}

function textoPorColuna(linha: CelulaBruta[], sharedStrings: string[]): Map<number, string | null> {
  const mapa = new Map<number, string | null>();
  for (const c of linha) mapa.set(colunaParaIndice(letraColuna(c.ref)), valorCelula(c, sharedStrings));
  return mapa;
}

function normalizarCabecalho(texto: string): string {
  return texto.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Converte data no formato dd/mm/aaaa (texto) OU serial de data do Excel para yyyy-mm-dd. */
function converterData(bruta: string | null): string | null {
  if (!bruta) return null;
  const textoMatch = bruta.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (textoMatch) return `${textoMatch[3]}-${textoMatch[2]}-${textoMatch[1]}`;
  const serial = Number(bruta);
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const data = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return data.toISOString().slice(0, 10);
}

/** Converte "dd/mm/aaaa hh:mm" para ISO 8601 (hora local do estabelecimento, sem timezone). */
function converterDataHora(bruta: string | null): string | null {
  if (!bruta) return null;
  const m = bruta.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})/);
  if (!m) return converterData(bruta) ? `${converterData(bruta)}T00:00:00` : null;
  const [, dd, mm, aaaa, hh, min] = m;
  return `${aaaa}-${mm}-${dd}T${hh}:${min}:00`;
}

function extrairPeriodo(todasLinhas: CelulaBruta[][], sharedStrings: string[]): { inicio: string | null; fim: string | null } {
  for (const linha of todasLinhas) {
    for (const celula of linha) {
      const texto = valorCelula(celula, sharedStrings);
      if (!texto) continue;
      const m = texto.match(/Periodo:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i);
      if (m) return { inicio: converterData(m[1]), fim: converterData(m[2]) };
    }
  }
  return { inicio: null, fim: null };
}

interface PlanilhaExtraida {
  nomeAba: string;
  linhas: CelulaBruta[][];
}

async function extrairPlanilhas(bytes: Uint8Array, nomeArquivo: string): Promise<{ planilhas: PlanilhaExtraida[]; sharedStrings: string[] }> {
  let arquivos;
  try {
    arquivos = await extrairArquivosZip(bytes, nomeArquivo);
  } catch (e) {
    if (e instanceof ZipParseError) throw new CartaoVendasParseError(e.message);
    throw e;
  }

  const workbookEntry = arquivos.find((a) => /xl\/workbook\.xml$/i.test(a.nome));
  const relsEntry = arquivos.find((a) => /xl\/_rels\/workbook\.xml\.rels$/i.test(a.nome));
  const sharedEntry = arquivos.find((a) => /xl\/sharedStrings\.xml$/i.test(a.nome));
  if (!workbookEntry || !relsEntry) {
    throw new CartaoVendasParseError(`Arquivo "${nomeArquivo}" não parece ser uma planilha Excel válida (workbook.xml não encontrado).`);
  }

  const workbookXml = new TextDecoder("utf-8").decode(workbookEntry.bytes);
  const relsXml = new TextDecoder("utf-8").decode(relsEntry.bytes);
  const sharedStrings = sharedEntry ? extrairStringsCompartilhadas(new TextDecoder("utf-8").decode(sharedEntry.bytes)) : [];

  const ridParaAlvo = new Map(
    [...relsXml.matchAll(/<Relationship\b[^>]*Id="(rId\d+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]])
  );
  const nomeParaRid = new Map(
    [...workbookXml.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="(rId\d+)"/g)].map((m) => [m[1], m[2]])
  );

  const planilhas: PlanilhaExtraida[] = [];
  for (const [nomeAba, rid] of nomeParaRid.entries()) {
    const alvo = ridParaAlvo.get(rid);
    if (!alvo) continue;
    const caminho = `xl/${alvo.replace(/^\/?xl\//, "")}`;
    const entry = arquivos.find((a) => a.nome.toLowerCase() === caminho.toLowerCase() || a.nome.toLowerCase().endsWith(alvo.toLowerCase()));
    if (!entry) continue;
    planilhas.push({ nomeAba, linhas: extrairLinhas(new TextDecoder("utf-8").decode(entry.bytes)) });
  }
  return { planilhas, sharedStrings };
}

/** Acha a linha de cabeçalho: primeira linha cujo texto de alguma célula bate com um dos marcadores. */
function acharCabecalho(linhas: CelulaBruta[][], sharedStrings: string[], marcadores: string[]): { indice: number; colunas: Map<string, number> } | null {
  for (let i = 0; i < linhas.length; i++) {
    const porColuna = textoPorColuna(linhas[i], sharedStrings);
    const textos = [...porColuna.values()].map((t) => (t ? normalizarCabecalho(t) : ""));
    if (marcadores.some((marcador) => textos.includes(marcador))) {
      const colunas = new Map<string, number>();
      for (const [indice, texto] of porColuna.entries()) {
        if (texto) colunas.set(normalizarCabecalho(texto), indice);
      }
      return { indice: i, colunas };
    }
  }
  return null;
}

function normalizarModalidadeBandeira(modalidadeBruta: string, origemPlanilha: OrigemPlanilha): ModalidadeCartao {
  if (origemPlanilha === "pix") return "pix";
  if (origemPlanilha === "voucher") return "voucher";
  const m = modalidadeBruta.trim().toLowerCase();
  if (m.startsWith("créd") || m.startsWith("cred")) return "credito";
  return "debito";
}

function normalizarStatus(statusBruto: string, origemPlanilha: OrigemPlanilha): StatusTransacaoCartao | null {
  const s = statusBruto.trim().toLowerCase();
  if (s === "aprovada") return "aprovada";
  if (s === "negada") return "negada";
  if (s === "estornada") return "estornada";
  if (s === "paga") return "paga";
  // Pix cujo QR Code nunca foi pago -- não é dinheiro perdido (nunca houve
  // venda), mas fica visível na lista de transações em vez de desaparecer
  // silenciosamente (confirmado com dado real: 84 ocorrências no período de
  // teste, "Qr Code Expirado" na coluna STATUS da aba PIX).
  if (s === "qr code expirado") return "expirada";
  if (origemPlanilha === "pix" && s === "") return "paga";
  return null;
}

const MARCADORES_DETALHADO = ["NÚMERO DO COMPROVANTE DE VENDAS (CV)"];

function parseAbaDetalhada(aba: PlanilhaExtraida, origemPlanilha: OrigemPlanilha, sharedStrings: string[], avisos: string[]): TransacaoCartao[] {
  const cabecalho = acharCabecalho(aba.linhas, sharedStrings, MARCADORES_DETALHADO);
  if (!cabecalho) return [];

  const col = (nome: string) => cabecalho.colunas.get(nome) ?? -1;
  const idxBandeira = col("BANDEIRA");
  const idxModalidade = col("MODALIDADE");
  const idxFormaPagamento = col("FORMA DE PAGAMENTO");
  const idxDataHora = origemPlanilha === "voucher" ? col("DATA DA VENDA") : col("DATA/HORA DA VENDA");
  const idxStatus = col("STATUS DA TRANSAÇÃO") !== -1 ? col("STATUS DA TRANSAÇÃO") : col("STATUS");
  const idxParcelas = col("PARCELAS");
  const idxDataPrevista = col("DATA PREVISTA DO 1º PAGAMENTO");
  const idxNumCartao = col("NÚMERO DO CARTÃO");
  const idxAutorizacao = col("NÚMERO DE AUTORIZAÇÃO (AUT)");
  const idxComprovante = col("NÚMERO DO COMPROVANTE DE VENDAS (CV)");
  const idxTerminal = col("NÚMERO DO TERMINAL");
  const idxValorBruto = col("VALOR BRUTO") !== -1 ? col("VALOR BRUTO") : col("VALOR DA VENDA");
  const idxValorTaxa = col("VALOR TAXA");
  const idxValorLiquido = col("VALOR LÍQUIDO");

  if (idxDataHora === -1 || idxValorBruto === -1 || idxStatus === -1) {
    avisos.push(`Aba "${aba.nomeAba}": colunas essenciais (data/valor/status) não encontradas -- aba ignorada.`);
    return [];
  }

  const transacoes: TransacaoCartao[] = [];
  for (let i = cabecalho.indice + 1; i < aba.linhas.length; i++) {
    const porColuna = textoPorColuna(aba.linhas[i], sharedStrings);
    const get = (idx: number) => (idx === -1 ? null : (porColuna.get(idx) ?? null));

    const dataHoraTexto = get(idxDataHora);
    const dataHoraVenda = converterDataHora(dataHoraTexto);
    const valorBrutoTexto = get(idxValorBruto);
    const valorBruto = valorBrutoTexto !== null ? Number(valorBrutoTexto) : NaN;
    const statusBruto = get(idxStatus);

    if (!dataHoraVenda || Number.isNaN(valorBruto) || !statusBruto) {
      if (porColuna.size > 0) avisos.push(`Aba "${aba.nomeAba}", linha ${i + 1}: data, valor ou status ausente/inválido -- linha ignorada.`);
      continue;
    }
    const statusTransacao = normalizarStatus(statusBruto, origemPlanilha);
    if (!statusTransacao) {
      avisos.push(`Aba "${aba.nomeAba}", linha ${i + 1}: status "${statusBruto}" desconhecido -- linha ignorada.`);
      continue;
    }

    const bandeira = idxBandeira !== -1 ? (get(idxBandeira) ?? "Desconhecida") : origemPlanilha === "pix" ? "Pix" : "Voucher";
    const modalidadeBruta = idxModalidade !== -1 ? (get(idxModalidade) ?? "") : "";
    const modalidade = normalizarModalidadeBandeira(modalidadeBruta, origemPlanilha);
    const valorTaxaTexto = get(idxValorTaxa);
    const valorLiquidoTexto = get(idxValorLiquido);

    const dadosBrutos: Record<string, string | null> = {};
    for (const [nomeColuna, indice] of cabecalho.colunas.entries()) {
      dadosBrutos[nomeColuna] = get(indice);
    }

    // "cartoes" sempre tem colunas de taxa/líquido no arquivo -- uma célula
    // vazia aqui é a adquirente arredondando uma taxa ínfima pra zero (ex.:
    // venda de R$0,01), não "taxa desconhecida". Confirmado com 3 vendas
    // reais de centavos no período de teste (VALOR TAXA e VALOR LÍQUIDO
    // vazios no arquivo). "pix" não tem coluna de líquido nenhuma (só
    // VALOR DA VENDA e VALOR TAXA), então líquido é sempre derivado de
    // bruto − taxa, nunca copiado do bruto direto -- importante se um dia a
    // adquirente cobrar taxa de Pix (hoje é sempre 0, mas não é garantido).
    // Já "voucher" não tem nenhuma das duas colunas -- aí sim fica null até
    // o usuário cadastrar a taxa contratada, nunca assume taxa zero sozinho.
    const taxaResolvida = valorTaxaTexto !== null ? Math.abs(Number(valorTaxaTexto)) : origemPlanilha === "voucher" ? null : 0;

    transacoes.push({
      origemPlanilha,
      bandeira,
      modalidade,
      formaPagamento: get(idxFormaPagamento),
      dataHoraVenda,
      statusTransacao,
      parcelas: (() => {
        const p = get(idxParcelas);
        const n = p ? parseInt(p, 10) : 1;
        return Number.isFinite(n) && n > 0 ? n : 1;
      })(),
      numeroCartaoMascarado: get(idxNumCartao),
      numeroAutorizacao: get(idxAutorizacao),
      numeroComprovante: get(idxComprovante),
      numeroTerminal: get(idxTerminal),
      valorBruto,
      valorTaxa: taxaResolvida,
      valorLiquido: valorLiquidoTexto !== null ? Number(valorLiquidoTexto) : taxaResolvida !== null ? Math.round((valorBruto - taxaResolvida) * 100) / 100 : null,
      dataPrevistaPagamento: idxDataPrevista !== -1 ? converterData(get(idxDataPrevista)) : origemPlanilha === "pix" ? dataHoraVenda.slice(0, 10) : null,
      dadosBrutos,
    });
  }
  return transacoes;
}

export async function parseCartaoVendasDetalhado(bytes: Uint8Array, nomeArquivo: string): Promise<ParseDetalhadoResult> {
  const { planilhas, sharedStrings } = await extrairPlanilhas(bytes, nomeArquivo);
  const avisos: string[] = [];
  const transacoes: TransacaoCartao[] = [];

  // Pix isolado por decisão do usuário: não dá pra conciliar contra o extrato
  // (o Pix da maquininha se mistura com Pix recebidos diretamente de
  // clientes no mesmo extrato, sem um identificador único em comum -- ao
  // contrário do cartão, que casa por bandeira+modalidade+data). Enquanto
  // não houver uma forma confiável de separar um do outro, o módulo nem
  // importa a aba PIX -- foco em Cartão (Crédito/Débito) e Voucher.
  const mapaOrigem: Record<string, OrigemPlanilha> = { CARTÕES: "cartoes", VOUCHER: "voucher" };
  for (const aba of planilhas) {
    const origemPlanilha = mapaOrigem[aba.nomeAba.trim().toUpperCase()];
    if (!origemPlanilha) continue; // PIX, RECARGA, VAN, etc. -- fora do escopo deste módulo
    transacoes.push(...parseAbaDetalhada(aba, origemPlanilha, sharedStrings, avisos));
  }

  if (transacoes.length === 0) {
    throw new CartaoVendasParseError(
      `Arquivo "${nomeArquivo}" não contém transações reconhecíveis. Confirme que é o relatório "Detalhado" (com NSU/comprovante por linha).`
    );
  }

  const todasLinhas = planilhas.flatMap((p) => p.linhas);
  const periodo = extrairPeriodo(todasLinhas, sharedStrings);
  return { transacoes, avisos, totalLinhasLidas: transacoes.length + avisos.length, periodoInicio: periodo.inicio, periodoFim: periodo.fim };
}

const MARCADORES_CONSOLIDADO_CARTOES = ["QUANTIDADE DE VENDAS"];

function parseAbaConsolidada(aba: PlanilhaExtraida, origemPlanilha: OrigemPlanilha, sharedStrings: string[], avisos: string[]): TotalConsolidado[] {
  const cabecalho = acharCabecalho(aba.linhas, sharedStrings, [...MARCADORES_CONSOLIDADO_CARTOES, "VALOR DA VENDA"]);
  if (!cabecalho) return [];

  const col = (nome: string) => cabecalho.colunas.get(nome) ?? -1;
  const idxBandeira = col("BANDEIRA");
  const idxModalidade = col("MODALIDADE");
  const idxValorBruto = col("VALOR BRUTO") !== -1 ? col("VALOR BRUTO") : col("VALOR DA VENDA");
  const idxTaxa = col("TAXA (R$)");
  const idxValorLiquido = col("VALOR LÍQUIDO");

  if (idxValorBruto === -1) {
    avisos.push(`Aba "${aba.nomeAba}" (consolidado): coluna de valor não encontrada -- aba ignorada na conferência de soma.`);
    return [];
  }

  const acumulado = new Map<string, TotalConsolidado>();
  for (let i = cabecalho.indice + 1; i < aba.linhas.length; i++) {
    const porColuna = textoPorColuna(aba.linhas[i], sharedStrings);
    const get = (idx: number) => (idx === -1 ? null : (porColuna.get(idx) ?? null));
    const valorBrutoTexto = get(idxValorBruto);
    const valorBruto = valorBrutoTexto !== null ? Number(valorBrutoTexto) : NaN;
    if (Number.isNaN(valorBruto)) continue;

    const bandeira = idxBandeira !== -1 ? (get(idxBandeira) ?? "Desconhecida") : origemPlanilha === "pix" ? "Pix" : "Voucher";
    const modalidadeBruta = idxModalidade !== -1 ? (get(idxModalidade) ?? "") : "";
    const modalidade = normalizarModalidadeBandeira(modalidadeBruta, origemPlanilha);
    const chave = `${bandeira}|${modalidade}`;
    const taxaTexto = get(idxTaxa);
    const liquidoTexto = get(idxValorLiquido);

    const existente = acumulado.get(chave);
    if (existente) {
      existente.totalBruto += valorBruto;
      if (taxaTexto !== null) existente.totalTaxa = (existente.totalTaxa ?? 0) + Math.abs(Number(taxaTexto));
      if (liquidoTexto !== null) existente.totalLiquido = (existente.totalLiquido ?? 0) + Number(liquidoTexto);
    } else {
      acumulado.set(chave, {
        origemPlanilha,
        bandeira,
        modalidade,
        totalBruto: valorBruto,
        totalTaxa: taxaTexto !== null ? Math.abs(Number(taxaTexto)) : null,
        totalLiquido: liquidoTexto !== null ? Number(liquidoTexto) : null,
      });
    }
  }
  return [...acumulado.values()];
}

export async function parseCartaoVendasConsolidado(bytes: Uint8Array, nomeArquivo: string): Promise<ParseConsolidadoResult> {
  const { planilhas, sharedStrings } = await extrairPlanilhas(bytes, nomeArquivo);
  const avisos: string[] = [];
  const totais: TotalConsolidado[] = [];

  // Mesmo recorte do Detalhado -- Pix isolado, não entra na prova de soma.
  const mapaOrigem: Record<string, OrigemPlanilha> = { CARTÕES: "cartoes", VOUCHER: "voucher" };
  for (const aba of planilhas) {
    const origemPlanilha = mapaOrigem[aba.nomeAba.trim().toUpperCase()];
    if (!origemPlanilha) continue;
    totais.push(...parseAbaConsolidada(aba, origemPlanilha, sharedStrings, avisos));
  }

  if (totais.length === 0) {
    throw new CartaoVendasParseError(`Arquivo "${nomeArquivo}" não contém totais reconhecíveis. Confirme que é o relatório "Consolidado".`);
  }

  const todasLinhas = planilhas.flatMap((p) => p.linhas);
  const periodo = extrairPeriodo(todasLinhas, sharedStrings);
  return { totais, avisos, periodoInicio: periodo.inicio, periodoFim: periodo.fim };
}

/** true se o arquivo tem a aba "CONSOLIDADO" (relatório agregado) OU se nenhuma aba tem NSU por linha. */
export async function detectarTipoArquivo(bytes: Uint8Array, nomeArquivo: string): Promise<"detalhado" | "consolidado"> {
  const { planilhas, sharedStrings } = await extrairPlanilhas(bytes, nomeArquivo);
  if (planilhas.some((p) => p.nomeAba.trim().toUpperCase() === "CONSOLIDADO")) return "consolidado";
  const temDetalhe = planilhas.some((p) => acharCabecalho(p.linhas, sharedStrings, MARCADORES_DETALHADO) !== null);
  return temDetalhe ? "detalhado" : "consolidado";
}
