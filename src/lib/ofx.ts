// Parser de extrato OFX (Santander) para a camada de staging /extrato.
// OFX do Santander é SGML (tags de folha sem fechamento), não XML bem-formado —
// por isso a extração é feita por regex sobre blocos <STMTTRN>...</STMTTRN>,
// que são os únicos elementos efetivamente fechados no formato.

export class OfxParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfxParseError";
  }
}

export interface OfxTransacao {
  fitid: string;
  data: string; // yyyy-mm-dd
  valor: number;
  tipo: string | null;
  descricao: string;
  descricaoNormalizada: string;
}

export interface OfxContaInfo {
  bankId: string | null;
  acctId: string | null;
  periodoInicio: string | null;
  periodoFim: string | null;
}

export interface OfxParseResult {
  conta: OfxContaInfo;
  transacoes: OfxTransacao[];
  avisos: string[];
}

export function normalizarDescricao(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectarEncoding(headerAscii: string): "utf-8" | "iso-8859-1" {
  const m = headerAscii.match(/(?:ENCODING|CHARSET)[:=]\s*"?([A-Za-z0-9-]+)"?/i);
  if (!m) return "iso-8859-1"; // padrão observado nos extratos do Santander
  const valor = m[1].toUpperCase();
  if (valor.includes("UTF")) return "utf-8";
  return "iso-8859-1";
}

/**
 * Decodifica os bytes crus do arquivo respeitando o charset declarado no cabeçalho OFX.
 * Usa apenas Uint8Array/TextDecoder (sem Buffer) para funcionar tanto no browser
 * quanto no servidor.
 */
export function decodificarOfx(bytes: Uint8Array, nomeArquivo: string): string {
  const head = new TextDecoder("iso-8859-1").decode(bytes.subarray(0, 512));
  const encoding = detectarEncoding(head);
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new OfxParseError(
      `Não foi possível ler "${nomeArquivo}": codificação declarada (${encoding}) não corresponde ao conteúdo do arquivo.`
    );
  }
}

function extrairCampo(bloco: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^\\r\\n<]*)`, "i");
  const m = bloco.match(re);
  const valor = m?.[1]?.trim();
  return valor ? valor : null;
}

function extrairData(bruto: string | null): string | null {
  if (!bruto) return null;
  const digitos = bruto.replace(/[^0-9]/g, "").slice(0, 8);
  if (digitos.length < 8) return null;
  return `${digitos.slice(0, 4)}-${digitos.slice(4, 6)}-${digitos.slice(6, 8)}`;
}

/** Parseia o texto já decodificado de um OFX de extrato bancário (Santander). */
export function parseOfx(texto: string, nomeArquivo: string): OfxParseResult {
  if (!/<OFX>/i.test(texto)) {
    throw new OfxParseError(`Arquivo "${nomeArquivo}" não é um extrato OFX válido (tag <OFX> não encontrada).`);
  }

  const blocos = texto.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? [];
  if (blocos.length === 0) {
    throw new OfxParseError(`Arquivo "${nomeArquivo}" não contém nenhum lançamento (<STMTTRN>).`);
  }

  const bankId = extrairCampo(texto, "BANKID");
  const acctId = extrairCampo(texto, "ACCTID");
  const periodoInicio = extrairData(extrairCampo(texto, "DTSTART"));
  const periodoFim = extrairData(extrairCampo(texto, "DTEND"));

  const transacoes: OfxTransacao[] = [];
  const avisos: string[] = [];

  blocos.forEach((bloco, indice) => {
    const fitid = extrairCampo(bloco, "FITID");
    const data = extrairData(extrairCampo(bloco, "DTPOSTED"));
    const valorBruto = extrairCampo(bloco, "TRNAMT");
    const tipo = extrairCampo(bloco, "TRNTYPE");
    const memo = extrairCampo(bloco, "MEMO");
    const name = extrairCampo(bloco, "NAME");

    if (!fitid || !data || !valorBruto) {
      avisos.push(`Lançamento #${indice + 1} ignorado: faltam campos obrigatórios (FITID, DTPOSTED ou TRNAMT).`);
      return;
    }

    const valor = Number(valorBruto.replace(",", "."));
    if (Number.isNaN(valor)) {
      avisos.push(`Lançamento #${indice + 1} (FITID ${fitid}) ignorado: TRNAMT "${valorBruto}" não é numérico.`);
      return;
    }

    const descricao = (memo && memo.length > 0 ? memo : name) ?? "(sem descrição)";

    transacoes.push({
      fitid,
      data,
      valor,
      tipo,
      descricao,
      descricaoNormalizada: normalizarDescricao(descricao),
    });
  });

  if (transacoes.length === 0) {
    throw new OfxParseError(`Arquivo "${nomeArquivo}" tem ${blocos.length} lançamento(s), mas nenhum com os campos obrigatórios completos.`);
  }

  return {
    conta: { bankId, acctId, periodoInicio, periodoFim },
    transacoes,
    avisos,
  };
}
