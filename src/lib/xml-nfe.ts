// Parser de XML de NF-e (nota fiscal eletrônica) para a camada de staging /xml-notas.
// Escopo desta fase é só cabeçalho + duplicatas (dados de produto ficam para o Cotar+).
// Implementado com regex sobre blocos de tag, sem DOMParser, para rodar igual em
// browser e em Node (mesma abordagem isomórfica do parser de OFX).

export class NFeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NFeParseError";
  }
}

export interface NFeDuplicata {
  numero: string | null;
  vencimento: string | null; // yyyy-mm-dd
  valor: number;
}

export interface NFeParseResult {
  chaveAcesso: string;
  fornecedorNome: string | null;
  fornecedorCnpj: string | null;
  numeroNota: string | null;
  valorTotal: number | null;
  emitidaEm: string | null; // yyyy-mm-dd
  duplicatas: NFeDuplicata[];
}

function extrairBloco(texto: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  return texto.match(re)?.[1] ?? null;
}

function extrairBlocos(texto: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "gi");
  return texto.match(re) ?? [];
}

function extrairTexto(texto: string, tag: string): string | null {
  const bloco = extrairBloco(texto, tag);
  return bloco !== null ? bloco.trim() : null;
}

function extrairAtributo(texto: string, tag: string, atributo: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\s${atributo}="([^"]*)"`, "i");
  return texto.match(re)?.[1] ?? null;
}

function detectarEncoding(headerAscii: string): "utf-8" | "iso-8859-1" {
  const m = headerAscii.match(/encoding="([A-Za-z0-9-]+)"/i);
  if (!m) return "utf-8";
  return m[1].toUpperCase().includes("8859") ? "iso-8859-1" : "utf-8";
}

/** Decodifica os bytes crus do XML respeitando o encoding declarado na declaração XML. */
export function decodificarXml(bytes: Uint8Array, nomeArquivo: string): string {
  const head = new TextDecoder("iso-8859-1").decode(bytes.subarray(0, 200));
  const encoding = detectarEncoding(head);
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new NFeParseError(`Não foi possível ler "${nomeArquivo}": encoding declarado (${encoding}) não corresponde ao conteúdo.`);
  }
}

export function parseNFe(xmlTexto: string, nomeArquivo: string): NFeParseResult {
  const infNFe = extrairBloco(xmlTexto, "infNFe");
  if (!infNFe) {
    throw new NFeParseError(`Arquivo "${nomeArquivo}" não parece ser uma NF-e (tag <infNFe> não encontrada).`);
  }

  let chaveAcesso: string | null = null;
  const idAttr = extrairAtributo(xmlTexto, "infNFe", "Id");
  if (idAttr) {
    const digitos = idAttr.replace(/[^0-9]/g, "");
    if (digitos.length === 44) chaveAcesso = digitos;
  }
  if (!chaveAcesso) {
    const chNFe = extrairTexto(xmlTexto, "chNFe");
    if (chNFe && /^\d{44}$/.test(chNFe)) chaveAcesso = chNFe;
  }
  if (!chaveAcesso) {
    throw new NFeParseError(`Arquivo "${nomeArquivo}": não foi possível extrair a chave de acesso (44 dígitos).`);
  }

  const emit = extrairBloco(infNFe, "emit") ?? "";
  const fornecedorNome = extrairTexto(emit, "xNome");
  const fornecedorCnpj = extrairTexto(emit, "CNPJ") ?? extrairTexto(emit, "CPF");

  const ide = extrairBloco(infNFe, "ide") ?? "";
  const numeroNota = extrairTexto(ide, "nNF");
  const dhEmiRaw = extrairTexto(ide, "dhEmi") ?? extrairTexto(ide, "dEmi");
  const emitidaEm = dhEmiRaw ? dhEmiRaw.slice(0, 10) : null;

  const totalBloco = extrairBloco(infNFe, "ICMSTot") ?? "";
  const valorTotalRaw = extrairTexto(totalBloco, "vNF");
  const valorTotal = valorTotalRaw ? Number(valorTotalRaw) : null;

  const duplicatas: NFeDuplicata[] = [];
  const cobrBloco = extrairBloco(infNFe, "cobr");
  if (cobrBloco) {
    for (const dupBloco of extrairBlocos(cobrBloco, "dup")) {
      const numero = extrairTexto(dupBloco, "nDup");
      const vencimento = extrairTexto(dupBloco, "dVenc");
      const valorRaw = extrairTexto(dupBloco, "vDup");
      const valor = valorRaw ? Number(valorRaw) : NaN;
      if (!Number.isNaN(valor)) duplicatas.push({ numero, vencimento, valor });
    }
  }

  return { chaveAcesso, fornecedorNome, fornecedorCnpj, numeroNota, valorTotal, emitidaEm, duplicatas };
}
