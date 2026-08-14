// Extrator mínimo de .zip para a camada de staging /xml-notas.
// Sem dependências novas: lê a estrutura ZIP (EOCD + diretório central) na mão e
// usa DecompressionStream("deflate-raw"), nativo em browser e Node 18+, para inflar
// entradas comprimidas. Suficiente para os .zip de anexos de e-mail com XMLs de NF-e.

export class ZipParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipParseError";
  }
}

export interface ArquivoZip {
  nome: string;
  bytes: Uint8Array;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;

// Mesmo teto usado pra um arquivo avulso (MAX_ARQUIVOS_TAMANHO em
// xml-notas/page.tsx) -- sem isso, um .zip pequeno (poucos KB) mas malicioso
// ou corrompido pode inflar pra gigabytes ("zip bomb") e travar a aba de quem
// importar. Checado por pedaço, não só no final, pra abortar cedo.
const MAX_TAMANHO_INFLADO = 10 * 1024 * 1024;

async function inflar(dados: Uint8Array, nomeEntrada: string, nomeArquivo: string): Promise<Uint8Array> {
  const stream = new Blob([dados as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TAMANHO_INFLADO) {
        await reader.cancel();
        throw new ZipParseError(
          `Arquivo "${nomeArquivo}": entrada "${nomeEntrada}" descompacta para mais de ${MAX_TAMANHO_INFLADO / (1024 * 1024)} MB -- rejeitada (possível .zip malformado).`
        );
      }
      partes.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const resultado = new Uint8Array(total);
  let offset = 0;
  for (const parte of partes) {
    resultado.set(parte, offset);
    offset += parte.byteLength;
  }
  return resultado;
}

export async function extrairArquivosZip(bytes: Uint8Array, nomeArquivo: string): Promise<ArquivoZip[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let eocdOffset = -1;
  const limiteInferior = Math.max(0, bytes.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = bytes.length - EOCD_MIN_SIZE; i >= limiteInferior; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new ZipParseError(`Arquivo "${nomeArquivo}" não é um .zip válido (assinatura de fim de diretório não encontrada).`);
  }

  const totalEntradas = view.getUint16(eocdOffset + 10, true);
  let cdOffset = view.getUint32(eocdOffset + 16, true);

  const arquivos: ArquivoZip[] = [];
  for (let i = 0; i < totalEntradas; i++) {
    if (cdOffset + 46 > bytes.length || view.getUint32(cdOffset, true) !== CENTRAL_DIR_SIG) {
      throw new ZipParseError(`Arquivo "${nomeArquivo}": diretório central do .zip corrompido.`);
    }

    const metodoCompressao = view.getUint16(cdOffset + 10, true);
    const tamanhoComprimido = view.getUint32(cdOffset + 20, true);
    const tamanhoNome = view.getUint16(cdOffset + 28, true);
    const tamanhoExtra = view.getUint16(cdOffset + 30, true);
    const tamanhoComentario = view.getUint16(cdOffset + 32, true);
    const offsetLocal = view.getUint32(cdOffset + 42, true);

    if (cdOffset + 46 + tamanhoNome > bytes.length) {
      throw new ZipParseError(`Arquivo "${nomeArquivo}": diretório central do .zip corrompido.`);
    }
    const nome = new TextDecoder("utf-8").decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + tamanhoNome));

    if (!nome.endsWith("/")) {
      // offsetLocal vem do próprio arquivo (não confiável) -- sem essa checagem,
      // um .zip malformado faz o próximo getUint16 estourar os limites do
      // ArrayBuffer com um RangeError bruto do JS em vez de um erro amigável.
      if (offsetLocal + 30 > bytes.length) {
        throw new ZipParseError(`Arquivo "${nomeArquivo}": entrada "${nome}" aponta para um cabeçalho local fora dos limites do arquivo.`);
      }
      const localNomeLen = view.getUint16(offsetLocal + 26, true);
      const localExtraLen = view.getUint16(offsetLocal + 28, true);
      const dadosInicio = offsetLocal + 30 + localNomeLen + localExtraLen;
      if (dadosInicio + tamanhoComprimido > bytes.length) {
        throw new ZipParseError(`Arquivo "${nomeArquivo}": entrada "${nome}" tem tamanho comprimido inconsistente com o arquivo.`);
      }
      const dadosComprimidos = bytes.subarray(dadosInicio, dadosInicio + tamanhoComprimido);

      let dados: Uint8Array;
      if (metodoCompressao === 0) {
        dados = dadosComprimidos;
      } else if (metodoCompressao === 8) {
        dados = await inflar(dadosComprimidos, nome, nomeArquivo);
      } else {
        throw new ZipParseError(`Arquivo "${nomeArquivo}": entrada "${nome}" usa compressão não suportada (método ${metodoCompressao}).`);
      }
      arquivos.push({ nome, bytes: dados });
    }

    cdOffset += 46 + tamanhoNome + tamanhoExtra + tamanhoComentario;
  }

  return arquivos;
}
