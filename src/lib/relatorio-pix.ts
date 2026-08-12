// Parser do relatório Pix do Santander (Excel) para a camada de staging /extrato.
// .xlsx é um .zip por dentro — reaproveita o extrator de zip já existente
// (lib/zip.ts, da Fase 2) para abrir as planilhas, sem nenhuma dependência nova.

import { extrairArquivosZip, ZipParseError } from "@/lib/zip";
import { normalizarDescricao } from "@/lib/ofx";

export class RelatorioPixParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelatorioPixParseError";
  }
}

export interface RelatorioPixLinha {
  data: string; // yyyy-mm-dd
  valor: number;
  pagador: string | null;
  idTransacao: string | null;
  descricao: string;
  descricaoNormalizada: string;
  ocorrencia: number;
}

export interface RelatorioPixParseResult {
  linhas: RelatorioPixLinha[];
  avisos: string[];
}

interface CelulaBruta {
  ref: string;
  tipo: string | null;
  valor: string | null;
}

function extrairCelulas(linhaXml: string): CelulaBruta[] {
  const celulasXml = linhaXml.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g) ?? [];
  return celulasXml.map((celulaXml) => ({
    ref: celulaXml.match(/\br="([A-Z]+\d+)"/)?.[1] ?? "",
    tipo: celulaXml.match(/\bt="([a-z]+)"/)?.[1] ?? null,
    valor: celulaXml.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? null,
  }));
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

function converterData(bruta: string | null): string | null {
  if (!bruta) return null;
  const m = bruta.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

export async function parseRelatorioPix(bytes: Uint8Array, nomeArquivo: string): Promise<RelatorioPixParseResult> {
  let arquivos;
  try {
    arquivos = await extrairArquivosZip(bytes, nomeArquivo);
  } catch (e) {
    if (e instanceof ZipParseError) throw new RelatorioPixParseError(e.message);
    throw e;
  }

  const sheetEntry = arquivos.find((a) => /xl\/worksheets\/sheet1\.xml$/i.test(a.nome));
  const sharedEntry = arquivos.find((a) => /xl\/sharedStrings\.xml$/i.test(a.nome));

  if (!sheetEntry) {
    throw new RelatorioPixParseError(
      `Arquivo "${nomeArquivo}" não parece ser uma planilha Excel válida (xl/worksheets/sheet1.xml não encontrado).`
    );
  }

  const sharedStrings = sharedEntry ? extrairStringsCompartilhadas(new TextDecoder("utf-8").decode(sharedEntry.bytes)) : [];
  const linhasBrutas = extrairLinhas(new TextDecoder("utf-8").decode(sheetEntry.bytes));

  if (linhasBrutas.length < 2) {
    throw new RelatorioPixParseError(`Arquivo "${nomeArquivo}" não contém lançamentos (planilha vazia ou só com cabeçalho).`);
  }

  const cabecalho = new Map(
    linhasBrutas[0].map((c) => [colunaParaIndice(letraColuna(c.ref)), (valorCelula(c, sharedStrings) ?? "").trim().toLowerCase()])
  );
  let indiceData = -1;
  let indiceValor = -1;
  let indicePagador = -1;
  let indiceIdTransacao = -1;
  for (const [coluna, nome] of cabecalho.entries()) {
    if (nome === "data") indiceData = coluna;
    else if (nome === "valor") indiceValor = coluna;
    else if (nome === "pagador") indicePagador = coluna;
    else if (nome === "id da transação") indiceIdTransacao = coluna;
  }

  if (indiceData === -1 || indiceValor === -1) {
    throw new RelatorioPixParseError(`Arquivo "${nomeArquivo}" não tem as colunas esperadas ("Data" e "Valor").`);
  }

  const linhas: RelatorioPixLinha[] = [];
  const avisos: string[] = [];

  for (let i = 1; i < linhasBrutas.length; i++) {
    const porColuna = new Map(linhasBrutas[i].map((c) => [colunaParaIndice(letraColuna(c.ref)), c]));
    const data = converterData(valorCelula(porColuna.get(indiceData), sharedStrings));
    const valorTexto = valorCelula(porColuna.get(indiceValor), sharedStrings);
    const valor = valorTexto !== null ? Number(valorTexto) : NaN;

    if (!data || Number.isNaN(valor)) {
      avisos.push(`Linha ${i + 1} ignorada: data ou valor inválido/ausente.`);
      continue;
    }

    const pagador = indicePagador !== -1 ? valorCelula(porColuna.get(indicePagador), sharedStrings) : null;
    const descricao = pagador ? `PIX RECEBIDO ${pagador}` : "PIX RECEBIDO";

    linhas.push({
      data,
      valor,
      pagador,
      idTransacao: indiceIdTransacao !== -1 ? valorCelula(porColuna.get(indiceIdTransacao), sharedStrings) : null,
      descricao,
      descricaoNormalizada: normalizarDescricao(descricao),
      ocorrencia: 0,
    });
  }

  if (linhas.length === 0) {
    throw new RelatorioPixParseError(`Arquivo "${nomeArquivo}" não contém nenhuma linha válida.`);
  }

  const contagem = new Map<string, number>();
  for (const l of linhas) {
    const chave = `${l.data}|${l.valor}|${l.descricaoNormalizada}`;
    const ocorrencia = contagem.get(chave) ?? 0;
    l.ocorrencia = ocorrencia;
    contagem.set(chave, ocorrencia + 1);
  }

  return { linhas, avisos };
}
