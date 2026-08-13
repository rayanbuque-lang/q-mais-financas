"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseOfx, decodificarOfx, OfxParseError } from "@/lib/ofx";
import { parseRelatorioPix, RelatorioPixParseError } from "@/lib/relatorio-pix";
import { calcularCobertura, type CandidatoOfx, type LancamentoExistentePix } from "@/lib/cobertura-pix";
import { aplicarRegras, type RegraExtrato as RegraMotor, type LancamentoClassificavel, type ResultadoClassificacao } from "@/lib/regras-extrato";
import { calcularTipoMovimentacao, agruparResumoPorDia, type ResumoDia } from "@/lib/preview-movimentacao";
import EmptyState from "@/components/empty-state";
import { calcularBaixasAutomaticas, type CandidatoBaixa, type ContaPagarPendente } from "@/lib/baixa-contas-pagar";
import { registrarLog, verificarMesFechado } from "@/lib/audit";

interface Conta {
  id: string;
  banco: string;
  apelido: string | null;
  agencia: string | null;
  conta: string | null;
}

interface Lancamento {
  id: string;
  conta_id: string;
  fitid: string;
  data_lancamento: string;
  valor: number;
  tipo: string | null;
  descricao: string;
  descricao_normalizada: string;
  categoria: string | null;
  regra_id: string | null;
  status: "nao_classificado" | "classificado" | "ignorado";
  classificado_em: string | null;
  revisado: boolean;
  conta_pagar_id: string | null;
  contas_pagar_candidatas: string[] | null;
  movimentacao_id: string | null;
  contas_pagar_duplicatas: string[] | null;
}

interface Regra {
  id: string;
  nome: string;
  tipo_match: "contem" | "comeca_com" | "regex";
  padrao: string;
  conta_id: string | null;
  valor_min: number | null;
  valor_max: number | null;
  categoria: string;
  prioridade: number;
  ativa: boolean;
  vezes_aplicada: number;
}

type Mensagem = { tipo: "sucesso" | "erro"; texto: string } | null;

// Teto de linhas por consulta a extrato_lancamento — supera o limite padrão do
// PostgREST (ver commit 693a921, mesmo problema em contas_pagar).
const LIMITE_LANCAMENTOS = 5000;

function formatarMoeda(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarData(iso: string) {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

function nomeConta(c: Conta) {
  return c.apelido || `${c.banco} · ${c.conta ?? "s/ número"}`;
}

const REGRA_FORM_INICIAL = {
  nome: "",
  tipo_match: "contem" as "contem" | "comeca_com" | "regex",
  padrao: "",
  conta_id: "",
  valor_min: "",
  valor_max: "",
  categoria: "",
  prioridade: "100",
  ativa: true,
};

interface LancamentoParaBaixa {
  id: string;
  conta_id: string;
  data_lancamento: string;
  valor: number;
  descricao_normalizada: string;
  status: string;
  contas_pagar_candidatas?: string[] | null;
  contas_pagar_duplicatas?: string[] | null;
}

// "ok" baixou; "mes_fechado" recusou de propósito (competência já fechada);
// "falhou" perdeu uma corrida ou algum write deu erro. Só "ok" conta como
// baixado nos resumos.
type ResultadoEscritaBaixa = "ok" | "mes_fechado" | "falhou";

// Reaproveita exatamente a mesma escrita que a baixa manual já faz em
// src/app/(app)/contas-pagar/page.tsx (confirmarPagamento) -- nenhum caminho
// de escrita novo em contas_pagar/movimentacoes. Usada tanto pela baixa
// automática (candidato único) quanto pela resolução manual de ambíguos.
//
// ORDEM DAS ESCRITAS (importa): claim do LANÇAMENTO -> claim da CONTA ->
// movimentação -> finalização do lançamento. Cada claim é um update
// condicional com .select("id") pra saber quantas linhas realmente mudaram.
// Proteger só a conta não bastava: duas abas podiam resolver o MESMO
// lançamento ambíguo contra contas DIFERENTES (ambas pendentes), passando
// as duas pelo guard da conta e gerando duas movimentações de saída para um
// único débito bancário. Reivindicando o lançamento primeiro, o segundo
// resolvedor para antes de escrever qualquer coisa.
async function baixarContaPagar(
  lancamento: { id: string; data_lancamento: string },
  conta: { id: string; fornecedor: string; valor: number; categoria_id: string | null },
  categoriaNome: string,
  origem: "automatica" | "manual"
): Promise<ResultadoEscritaBaixa> {
  const supabase = createClient();

  // A movimentação é gravada com a data real do banco (data_lancamento), que
  // pode cair num mês já fechado contabilmente — o resto do sistema bloqueia
  // esse tipo de escrita, a baixa automática também tem que bloquear.
  const { fechado } = await verificarMesFechado(lancamento.data_lancamento);
  if (fechado) return "mes_fechado";

  // 1) Claim do lançamento: só vence quem encontrar conta_pagar_id ainda nulo.
  const { data: lancamentoReivindicado, error: erroClaim } = await supabase
    .from("extrato_lancamento")
    .update({ conta_pagar_id: conta.id })
    .eq("id", lancamento.id)
    .is("conta_pagar_id", null)
    .select("id");
  if (erroClaim || !lancamentoReivindicado || lancamentoReivindicado.length === 0) return "falhou";

  // 2) Claim da conta: .eq("status","pendente") só bate se a conta ainda
  // estiver pendente -- se dois lançamentos do mesmo lote casarem com a
  // MESMA conta (mesmo valor, mesmo fornecedor, só uma pendente no banco),
  // o segundo update aqui afeta zero linhas (a primeira chamada já pagou),
  // e isso tem que virar "não baixou" -- senão duplicaria a movimentação
  // de saída para o mesmo pagamento.
  const { data: linhasAtualizadas, error: erroBaixa } = await supabase
    .from("contas_pagar")
    .update({ status: "pago", data_pagamento: lancamento.data_lancamento })
    .eq("id", conta.id)
    .eq("status", "pendente")
    .select("id");
  if (erroBaixa || !linhasAtualizadas || linhasAtualizadas.length === 0) {
    // Zero linhas SEM erro = a conta não estava mais pendente, logo nada foi
    // escrito por nós: devolvemos o lançamento pro pool (guardado por
    // .eq("conta_pagar_id", conta.id) pra não pisar em claim de terceiro),
    // senão ele ficaria travado pra sempre — nenhuma outra tentativa
    // conseguiria reivindicá-lo. Se veio ERRO, o estado da conta é
    // desconhecido: aí mantemos o claim de propósito, porque "lançamento
    // reivindicado sem baixa completa" é detectável, enquanto desfazer o
    // claim por cima de uma conta possivelmente paga não é.
    if (!erroBaixa) {
      await supabase
        .from("extrato_lancamento")
        .update({ conta_pagar_id: null })
        .eq("id", lancamento.id)
        .eq("conta_pagar_id", conta.id);
    }
    return "falhou";
  }

  // 3) Movimentação. Erro aqui não pode virar sucesso silencioso: em lote o
  // resumo diria "N baixados" contando uma saída que nunca foi lançada.
  const { error: erroMovimentacao } = await supabase.from("movimentacoes").insert({
    tipo: "saida",
    data: lancamento.data_lancamento,
    valor: conta.valor,
    categoria_id: conta.categoria_id,
    observacao: `Pagamento: ${conta.fornecedor}`,
    revisar: false,
    conta_pagar_id: conta.id,
  });
  if (erroMovimentacao) return "falhou";

  // 4) Finaliza a classificação do lançamento (o vínculo já foi gravado no
  // passo 1). Resolução manual é decisão humana: carimba classificado_por,
  // igual handleClassificarManual.
  let classificadoPor: string | null = null;
  if (origem === "manual") {
    const { data: { user } } = await supabase.auth.getUser();
    classificadoPor = user?.id ?? null;
  }
  const { error: erroLancamento } = await supabase
    .from("extrato_lancamento")
    .update({
      status: "classificado",
      categoria: categoriaNome,
      classificado_em: new Date().toISOString(),
      classificado_por: classificadoPor,
      contas_pagar_candidatas: null,
    })
    .eq("id", lancamento.id);
  if (erroLancamento) return "falhou";

  await registrarLog({
    acao: "pagou",
    tabela: "contas_pagar",
    registroId: conta.id,
    detalhes: `${conta.fornecedor} - ${origem === "manual" ? "baixa manual (ambiguidade resolvida) via extrato" : "baixa automática via extrato"}`,
  });
  return "ok";
}

// Roda sobre lançamentos de saída recém-chegados (import de OFX ou
// reprocessamento). Nunca decide um empate sozinho -- ver calcularBaixasAutomaticas.
async function processarBaixasAutomaticas(
  lancamentosNovos: LancamentoParaBaixa[]
): Promise<{ baixados: number; ambiguos: number; duplicatas: number; mesFechado: number; idsBaixados: Set<string>; idsAmbiguos: Set<string>; idsDuplicatas: Set<string> }> {
  const supabase = createClient();
  const idsBaixados = new Set<string>();
  const idsAmbiguos = new Set<string>();
  const idsDuplicatas = new Set<string>();
  const saidas = lancamentosNovos.filter((l) => l.valor < 0 && l.status === "nao_classificado");
  if (saidas.length === 0) return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };

  // Consultas separadas (não uma só com .in) -- contas pendentes e pagas têm
  // volumes muito diferentes (pagas crescem ~300/mês, pendentes ficam baixas
  // sempre), uma única consulta com limite compartilhado arriscava pendentes
  // recentes ficarem de fora quando pagas passassem do teto sozinhas.
  // .limit(2000) em cada uma por precaução -- mesma classe de problema já
  // corrigida antes neste projeto (commit 693a921). A busca de pagas é
  // recortada aos últimos ~12 meses -- conta paga muito antiga não é
  // candidata realista de duplicata, e isso mantém a consulta pequena.
  const dataMinimaPagas = new Date();
  dataMinimaPagas.setFullYear(dataMinimaPagas.getFullYear() - 1);
  const dataMinimaPagasIso = dataMinimaPagas.toISOString().slice(0, 10);

  const [{ data: pendentesRaw, error: erroPendentes }, { data: pagasRaw, error: erroPagas }] = await Promise.all([
    supabase.from("contas_pagar").select("id, fornecedor, valor, categoria_id").eq("status", "pendente").limit(2000),
    supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, categoria_id, data_pagamento")
      .eq("status", "pago")
      .gte("data_pagamento", dataMinimaPagasIso)
      .limit(2000),
  ]);
  // Erro de consulta não pode virar "zero contas": isso limparia sinalizações
  // existentes e liberaria lançamentos que na verdade não foram checados
  // contra nada -- uma falha passageira de rede não pode se transformar na
  // duplicação que esta função existe pra evitar. Retorna sem tocar nas
  // funções de limpeza, deixando tudo como estava.
  if (erroPendentes || erroPagas) {
    return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };
  }

  const pendentes = pendentesRaw ?? [];
  const pagas = pagasRaw ?? [];
  if (pendentes.length === 0 && pagas.length === 0) {
    await Promise.all([limparCandidatasObsoletas(saidas, new Set<number>()), limparDuplicatasObsoletas(saidas, new Set<number>())]);
    return { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados, idsAmbiguos, idsDuplicatas };
  }

  const { data: categoriasSaidaTodas } = await supabase.from("categorias_saida").select("id, nome");
  const nomeCategoriaPorId = new Map((categoriasSaidaTodas ?? []).map((c) => [c.id as string, c.nome as string]));

  const candidatos: CandidatoBaixa[] = saidas.map((l, indice) => ({
    indice,
    valor: Math.abs(Number(l.valor)),
    descricaoNormalizada: l.descricao_normalizada,
    data: l.data_lancamento,
  }));
  const contasPendentes: ContaPagarPendente[] = pendentes.map((c) => ({
    id: c.id as string,
    fornecedor: c.fornecedor as string,
    valor: Number(c.valor),
  }));
  const contasPagas: ContaPagarPendente[] = pagas.map((c) => ({
    id: c.id as string,
    fornecedor: c.fornecedor as string,
    valor: Number(c.valor),
    dataPagamento: c.data_pagamento as string | null,
  }));

  const resultado = calcularBaixasAutomaticas(candidatos, contasPendentes, contasPagas);
  const pendentesPorId = new Map(pendentes.map((c) => [c.id as string, c]));

  let baixados = 0;
  let mesFechado = 0;
  for (const b of resultado.baixados) {
    const lancamento = saidas[b.indice];
    const conta = pendentesPorId.get(b.contaPagarId);
    if (!conta) continue;
    const categoriaId = conta.categoria_id as string | null;
    const categoriaNome = categoriaId ? nomeCategoriaPorId.get(categoriaId) ?? "Contas a pagar" : "Contas a pagar";
    const resultadoEscrita = await baixarContaPagar(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento },
      { id: conta.id as string, fornecedor: conta.fornecedor as string, valor: Number(conta.valor), categoria_id: categoriaId },
      categoriaNome,
      "automatica"
    );
    if (resultadoEscrita === "ok") {
      idsBaixados.add(lancamento.id);
      baixados++;
    } else if (resultadoEscrita === "mes_fechado") {
      mesFechado++;
    }
  }

  let ambiguos = 0;
  for (const a of resultado.ambiguos) {
    const lancamento = saidas[a.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: a.candidatosIds }).eq("id", lancamento.id);
    idsAmbiguos.add(lancamento.id);
    ambiguos++;
  }

  let duplicatas = 0;
  for (const d of resultado.duplicatas) {
    const lancamento = saidas[d.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_duplicatas: d.candidatosIds }).eq("id", lancamento.id);
    idsDuplicatas.add(lancamento.id);
    duplicatas++;
  }

  const indicesComResultado = new Set<number>([
    ...resultado.baixados.map((b) => b.indice),
    ...resultado.ambiguos.map((a) => a.indice),
  ]);
  const indicesComDuplicata = new Set<number>(resultado.duplicatas.map((d) => d.indice));
  await Promise.all([
    limparCandidatasObsoletas(saidas, indicesComResultado),
    limparDuplicatasObsoletas(saidas, indicesComDuplicata),
  ]);

  return { baixados, ambiguos, duplicatas, mesFechado, idsBaixados, idsAmbiguos, idsDuplicatas };
}

// Um lançamento que já ficou ambíguo carrega contas_pagar_candidatas até
// alguém resolver. Se num reprocessamento posterior o motor não encontra mais
// candidato nenhum (as contas empatadas foram pagas por outro meio, ou o
// fornecedor curto demais deixou de casar), esse array vira lixo: a UI segue
// mostrando "Baixa ambígua (N)" e todo clique falha. Limpa quem tinha
// candidatas e não produziu nem baixa nem ambiguidade nesta rodada.
async function limparCandidatasObsoletas(saidas: LancamentoParaBaixa[], indicesComResultado: Set<number>) {
  const idsObsoletos = saidas
    .filter((l, indice) => !indicesComResultado.has(indice) && (l.contas_pagar_candidatas?.length ?? 0) > 0)
    .map((l) => l.id);
  if (idsObsoletos.length === 0) return;
  const supabase = createClient();
  await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: null }).in("id", idsObsoletos);
}

// Mesma lógica de limparCandidatasObsoletas, mas pro campo de duplicatas: se
// um reprocessamento posterior não encontra mais nenhuma conta paga batendo
// (a duplicata era falsa, ou a conta paga foi excluída), o marcador vira
// lixo e o botão "Provável duplicata" ficaria preso pra sempre.
async function limparDuplicatasObsoletas(saidas: LancamentoParaBaixa[], indicesComResultado: Set<number>) {
  const idsObsoletos = saidas
    .filter((l, indice) => !indicesComResultado.has(indice) && (l.contas_pagar_duplicatas?.length ?? 0) > 0)
    .map((l) => l.id);
  if (idsObsoletos.length === 0) return;
  const supabase = createClient();
  await supabase.from("extrato_lancamento").update({ contas_pagar_duplicatas: null }).in("id", idsObsoletos);
}

// ---------- Lançamento direto em Movimentações (Capacidade A) ----------
// Todo lançamento de saída cuja descrição bate no padrão de boleto é domínio
// EXCLUSIVO da baixa automática de contas a pagar (Capacidade B) -- nunca vira
// movimentação genérica por aqui, mesmo sem ter achado conta correspondente.
// Mesmo texto que a extrato_regra "Pagamento de boletos" já usa hoje.
const PADRAO_BOLETO = "pagamento de boleto";

function ehPagamentoDeBoleto(descricaoNormalizada: string): boolean {
  return descricaoNormalizada.includes(PADRAO_BOLETO);
}

interface LancamentoParaMovimentacao {
  id: string;
  data_lancamento: string;
  valor: number;
  descricao_normalizada: string;
}

// "ok" lançou; "mes_fechado" recusou de propósito (mesma proteção da
// Capacidade B); "nao_lancado" cobre os dois casos silenciosos -- padrão de
// boleto, ou categoria sem correspondência real -- nenhum dos dois é erro,
// o lançamento simplesmente continua só classificado no staging; "falhou"
// cobre erro real de escrita (insert/update deram erro, ou a proteção contra
// corrida em 2b abaixo detectou que o lançamento já tinha sido processado) --
// isso NÃO é silencioso, tem que ser contado separado dos outros três.
type ResultadoLancamentoDireto = "ok" | "mes_fechado" | "falhou" | "nao_lancado";

async function carregarMapasCategoria(): Promise<{ entrada: Map<string, string>; saida: Map<string, string> }> {
  const supabase = createClient();
  const [{ data: catsEntrada }, { data: catsSaida }] = await Promise.all([
    supabase.from("categorias_entrada").select("id, nome"),
    supabase.from("categorias_saida").select("id, nome"),
  ]);
  return {
    entrada: new Map((catsEntrada ?? []).map((c) => [c.nome as string, c.id as string])),
    saida: new Map((catsSaida ?? []).map((c) => [c.nome as string, c.id as string])),
  };
}

// Reaproveitada tanto pelo caminho automático (processarLancamentosDiretos,
// logo depois de classificarPorRegras) quanto pelo manual
// (handleClassificarManual, depois de gravar a categoria no staging).
async function lancarMovimentacaoDireta(
  lancamento: LancamentoParaMovimentacao,
  categoriaNome: string,
  mapaCategoriaEntrada: Map<string, string>,
  mapaCategoriaSaida: Map<string, string>
): Promise<ResultadoLancamentoDireto> {
  // Incondicional -- boleto é domínio exclusivo da Capacidade B mesmo quando o
  // valor não é negativo (ex.: estorno de um pagamento de boleto).
  if (ehPagamentoDeBoleto(lancamento.descricao_normalizada)) return "nao_lancado";

  const tipo = calcularTipoMovimentacao(lancamento.valor);
  const mapa = tipo === "entrada" ? mapaCategoriaEntrada : mapaCategoriaSaida;
  const categoriaId = mapa.get(categoriaNome);
  if (!categoriaId) return "nao_lancado";

  const supabase = createClient();

  const { fechado } = await verificarMesFechado(lancamento.data_lancamento);
  if (fechado) return "mes_fechado";

  const { data: movimentacaoInserida, error: erroInsert } = await supabase
    .from("movimentacoes")
    .insert({
      tipo,
      data: lancamento.data_lancamento,
      valor: Math.abs(Number(lancamento.valor)),
      categoria_id: categoriaId,
      observacao: lancamento.descricao_normalizada,
      revisar: false,
    })
    .select("id")
    .single();
  if (erroInsert || !movimentacaoInserida) return "falhou";

  // Defesa em profundidade: mesmo que handleClassificarManual já feche a
  // corrida na origem (update condicional a status="nao_classificado" antes
  // de chegar aqui), o update final também é condicional a movimentacao_id
  // ainda estar nulo -- se 0 linhas mudaram, este lançamento já foi
  // processado por outra chamada, e a movimentação que acabamos de inserir
  // ficaria órfã (sem vínculo) se tratássemos isso como sucesso silencioso.
  const { data: linhasAtualizadas, error: erroLancamento } = await supabase
    .from("extrato_lancamento")
    .update({ movimentacao_id: movimentacaoInserida.id })
    .eq("id", lancamento.id)
    .is("movimentacao_id", null)
    .select("id");
  if (erroLancamento || !linhasAtualizadas || linhasAtualizadas.length === 0) return "falhou";

  await registrarLog({
    acao: "criou",
    tabela: "movimentacoes",
    registroId: movimentacaoInserida.id,
    detalhes: `${categoriaNome} - ${formatarMoeda(Math.abs(Number(lancamento.valor)))} lançado direto a partir do extrato (${lancamento.descricao_normalizada})`,
  });

  return "ok";
}

// Roda sobre o que classificarPorRegras acabou de classificar nesta execução
// -- não sobre "tudo que está classificado hoje" (sem backfill retroativo).
async function processarLancamentosDiretos(
  candidatos: LancamentoParaBaixa[],
  resultadosRegra: ResultadoClassificacao[]
): Promise<{ lancados: number; mesFechado: number; falharam: number }> {
  if (resultadosRegra.length === 0) return { lancados: 0, mesFechado: 0, falharam: 0 };

  const { entrada, saida } = await carregarMapasCategoria();
  const porId = new Map(candidatos.map((c) => [c.id, c]));

  let lancados = 0;
  let mesFechado = 0;
  let falharam = 0;
  for (const r of resultadosRegra) {
    const lancamento = porId.get(r.lancamentoId);
    if (!lancamento) continue;
    const resultado = await lancarMovimentacaoDireta(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento, valor: lancamento.valor, descricao_normalizada: lancamento.descricao_normalizada },
      r.categoria,
      entrada,
      saida
    );
    if (resultado === "ok") lancados++;
    else if (resultado === "mes_fechado") mesFechado++;
    else if (resultado === "falhou") falharam++;
  }
  return { lancados, mesFechado, falharam };
}

export default function ExtratoPage() {
  const supabase = createClient();

  const [role, setRole] = useState<string | null>(null);
  const podeEscrever = role === "master" || role === "funcionario";

  const [aba, setAba] = useState<"importar" | "lancamentos" | "regras">("importar");
  const [mensagem, setMensagem] = useState<Mensagem>(null);

  const [contas, setContas] = useState<Conta[]>([]);

  // Importar
  const [contaImportId, setContaImportId] = useState("");
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [importando, setImportando] = useState(false);
  const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; duplicatas: number; mesFechado: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; movimentacoesFalharam: number; avisos: string[] } | null>(null);
  const [mostrarNovaConta, setMostrarNovaConta] = useState(false);
  const [novaContaBanco, setNovaContaBanco] = useState("santander");
  const [novaContaApelido, setNovaContaApelido] = useState("");
  const [novaContaAgencia, setNovaContaAgencia] = useState("");
  const [novaContaNumero, setNovaContaNumero] = useState("");
  const [criandoConta, setCriandoConta] = useState(false);
  const inputArquivoRef = useRef<HTMLInputElement>(null);
  const [arquivoPix, setArquivoPix] = useState<File | null>(null);
  const [importandoPix, setImportandoPix] = useState(false);
  const [resumoImportacaoPix, setResumoImportacaoPix] = useState<{ lidas: number; novas: number; duplicadas: number; movimentacoesLancadas: number; movimentacoesMesFechado: number; movimentacoesFalharam: number; avisos: string[] } | null>(null);
  const inputArquivoPixRef = useRef<HTMLInputElement>(null);

  // Lançamentos
  const [lancamentos, setLancamentos] = useState<Lancamento[]>([]);
  const [carregandoLancamentos, setCarregandoLancamentos] = useState(false);
  const [filtroContaId, setFiltroContaId] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | "nao_classificado" | "classificado" | "ignorado">("todos");
  const [ocultarRevisados, setOcultarRevisados] = useState(true);
  const [ocultarIgnorados, setOcultarIgnorados] = useState(true);
  const [resumo, setResumo] = useState({ total: 0, classificados: 0, naoClassificados: 0, automaticos: 0 });
  const [diaExpandido, setDiaExpandido] = useState<string | null>(null);
  const [confirmandoDia, setConfirmandoDia] = useState<string | null>(null);
  const [reprocessando, setReprocessando] = useState(false);
  const [categoriaEmEdicao, setCategoriaEmEdicao] = useState<Record<string, string>>({});
  const [acaoLancamentoId, setAcaoLancamentoId] = useState<string | null>(null);
  const [sugerirRegraPara, setSugerirRegraPara] = useState<{ lancamento: Lancamento; categoria: string } | null>(null);
  const [trechoRegra, setTrechoRegra] = useState("");
  const [escopoContaRegra, setEscopoContaRegra] = useState(true);
  const [criandoRegraSugerida, setCriandoRegraSugerida] = useState(false);
  const [resolvendoAmbiguo, setResolvendoAmbiguo] = useState<{
    lancamento: Lancamento;
    candidatos: { id: string; fornecedor: string; valor: number; data_vencimento: string; categoria_id: string | null }[];
  } | null>(null);
  const [carregandoCandidatos, setCarregandoCandidatos] = useState(false);
  const [resolvendoBaixaId, setResolvendoBaixaId] = useState<string | null>(null);
  const [resolvendoDuplicata, setResolvendoDuplicata] = useState<{
    lancamento: Lancamento;
    candidatos: { id: string; fornecedor: string; valor: number; data_pagamento: string | null }[];
  } | null>(null);
  const [carregandoDuplicata, setCarregandoDuplicata] = useState(false);

  // Regras
  const [regras, setRegras] = useState<Regra[]>([]);
  const [carregandoRegras, setCarregandoRegras] = useState(false);
  const [mostrarFormRegra, setMostrarFormRegra] = useState(false);
  const [editandoRegraId, setEditandoRegraId] = useState<string | null>(null);
  const [formRegra, setFormRegra] = useState(REGRA_FORM_INICIAL);
  const [salvandoRegra, setSalvandoRegra] = useState(false);

  // Categorias reais (categorias_entrada / categorias_saida) — só leitura,
  // nunca escrevemos nessas tabelas.
  const [categoriasEntrada, setCategoriasEntrada] = useState<string[]>([]);
  const [categoriasSaida, setCategoriasSaida] = useState<string[]>([]);

  const resumoPorDia = agruparResumoPorDia(lancamentos);

  async function carregarContas() {
    const { data, error } = await supabase.from("extrato_conta").select("*").order("banco").order("apelido");
    if (!error && data) setContas(data as Conta[]);
  }

  async function carregarCategoriasReais() {
    const [
      { data: entrada, error: erroEntrada },
      { data: saida, error: erroSaida },
    ] = await Promise.all([
      supabase.from("categorias_entrada").select("nome").eq("ativo", true).order("nome"),
      supabase.from("categorias_saida").select("nome").eq("ativo", true).order("nome"),
    ]);
    if (erroEntrada || erroSaida) {
      const detalhes = [erroEntrada?.message, erroSaida?.message].filter(Boolean).join("; ");
      setMensagem({ tipo: "erro", texto: "Erro ao carregar categorias reais: " + detalhes });
      return;
    }
    setCategoriasEntrada((entrada ?? []).map((c) => c.nome as string));
    setCategoriasSaida((saida ?? []).map((c) => c.nome as string));
  }

  async function carregarLancamentos() {
    setCarregandoLancamentos(true);
    let query = supabase
      .from("extrato_lancamento")
      .select("*")
      .order("data_lancamento", { ascending: false })
      .order("id", { ascending: false })
      .limit(LIMITE_LANCAMENTOS);
    if (filtroContaId) query = query.eq("conta_id", filtroContaId);
    if (filtroStatus !== "todos") query = query.eq("status", filtroStatus);
    // Ignorado = "isso não é uma movimentação real", não deve poluir a lista de
    // trabalho. Some por padrão; só reaparece se o usuário filtrar status=ignorado
    // de propósito pra conferir o que já foi descartado.
    if (ocultarIgnorados && filtroStatus !== "ignorado") query = query.neq("status", "ignorado");
    // "Confirmar dia" marca revisado=true; ocultar por padrão pra lista de trabalho
    // ir esvaziando conforme o usuário revisa (o dia inteiro some da tabela e do
    // resumo). Continua tudo lá no banco, só não aparece nessa visão por padrão.
    if (ocultarRevisados) query = query.eq("revisado", false);
    const { data, error } = await query;
    if (!error && data) setLancamentos(data as Lancamento[]);
    setCarregandoLancamentos(false);
  }

  async function carregarResumo() {
    let totalQ = supabase.from("extrato_lancamento").select("*", { count: "exact", head: true });
    let classQ = supabase.from("extrato_lancamento").select("*", { count: "exact", head: true }).eq("status", "classificado");
    let naoQ = supabase.from("extrato_lancamento").select("*", { count: "exact", head: true }).eq("status", "nao_classificado");
    // "Automático" = classificado sem alguém digitar a categoria: por regra OU
    // por baixa de conta a pagar (a baixa também é uma classificação automática,
    // só que vinda do casamento com contas_pagar em vez do motor de regras).
    let autoQ = supabase
      .from("extrato_lancamento")
      .select("*", { count: "exact", head: true })
      .eq("status", "classificado")
      .or("regra_id.not.is.null,conta_pagar_id.not.is.null");

    if (filtroContaId) {
      totalQ = totalQ.eq("conta_id", filtroContaId);
      classQ = classQ.eq("conta_id", filtroContaId);
      naoQ = naoQ.eq("conta_id", filtroContaId);
      autoQ = autoQ.eq("conta_id", filtroContaId);
    }

    const [{ count: total }, { count: classificados }, { count: naoClassificados }, { count: automaticos }] = await Promise.all([
      totalQ,
      classQ,
      naoQ,
      autoQ,
    ]);

    setResumo({
      total: total ?? 0,
      classificados: classificados ?? 0,
      naoClassificados: naoClassificados ?? 0,
      automaticos: automaticos ?? 0,
    });
  }

  async function carregarRegras() {
    setCarregandoRegras(true);
    const { data, error } = await supabase.from("extrato_regra").select("*").order("prioridade", { ascending: true }).order("criada_em", { ascending: true });
    if (!error && data) setRegras(data as Regra[]);
    setCarregandoRegras(false);
  }

  async function refrescarTudo() {
    await Promise.all([carregarLancamentos(), carregarResumo(), carregarRegras()]);
  }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarContas();
    carregarRegras();
    carregarCategoriasReais();
  }, []);

  useEffect(() => {
    carregarLancamentos();
    carregarResumo();
  }, [filtroContaId, filtroStatus, ocultarRevisados, ocultarIgnorados]);

  // ---------- Motor de regras ----------

  async function classificarPorRegras(candidatos: LancamentoClassificavel[]): Promise<ResultadoClassificacao[]> {
    if (candidatos.length === 0) return [];
    const { data: regrasAtivas, error } = await supabase.from("extrato_regra").select("*").eq("ativa", true);
    if (error || !regrasAtivas || regrasAtivas.length === 0) return [];

    const resultados = aplicarRegras(candidatos, regrasAtivas as RegraMotor[]);
    if (resultados.length === 0) return [];

    const agora = new Date().toISOString();
    await Promise.all(
      resultados.map((r) =>
        supabase
          .from("extrato_lancamento")
          .update({ categoria: r.categoria, regra_id: r.regraId, status: "classificado", classificado_em: agora })
          .eq("id", r.lancamentoId)
      )
    );

    const contagemPorRegra = new Map<string, number>();
    for (const r of resultados) contagemPorRegra.set(r.regraId, (contagemPorRegra.get(r.regraId) ?? 0) + 1);

    await Promise.all(
      Array.from(contagemPorRegra.entries()).map(([regraId, qtd]) => {
        const regraAtual = regrasAtivas.find((r: Regra) => r.id === regraId);
        const novoTotal = (regraAtual?.vezes_aplicada ?? 0) + qtd;
        return supabase.from("extrato_regra").update({ vezes_aplicada: novoTotal }).eq("id", regraId);
      })
    );

    return resultados;
  }

  async function handleReprocessar() {
    if (!podeEscrever) return;
    setMensagem(null);
    setReprocessando(true);
    try {
      let query = supabase
        .from("extrato_lancamento")
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento, contas_pagar_candidatas, contas_pagar_duplicatas")
        .eq("status", "nao_classificado")
        // Mesmo teto de carregarLancamentos — sem .limit() o PostgREST corta na
        // sua página padrão e o reprocessamento silenciosamente ignora o resto.
        .limit(LIMITE_LANCAMENTOS);
      if (filtroContaId) query = query.eq("conta_id", filtroContaId);
      const { data: candidatos, error } = await query;
      if (error) throw new Error(error.message);

      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter(
        (l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id) && !baixasAuto.idsDuplicatas.has(l.id)
      );
      const resultadosRegra = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
      const qtd = resultadosRegra.length;
      const lancamentosDiretos = await processarLancamentosDiretos(paraClassificar, resultadosRegra);

      const partes: string[] = [];
      if (baixasAuto.baixados > 0) partes.push(`${baixasAuto.baixados} baixado(s) automaticamente`);
      if (baixasAuto.ambiguos > 0) partes.push(`${baixasAuto.ambiguos} ambíguo(s) (revisar)`);
      if (baixasAuto.duplicatas > 0) partes.push(`${baixasAuto.duplicatas} sinalizado(s) como provável duplicata (revisar)`);
      if (baixasAuto.mesFechado > 0) partes.push(`${baixasAuto.mesFechado} não baixado(s): mês contábil fechado`);
      if (qtd > 0) partes.push(`${qtd} classificado(s) por regra`);
      if (lancamentosDiretos.lancados > 0) partes.push(`${lancamentosDiretos.lancados} lançado(s) em movimentações`);
      if (lancamentosDiretos.mesFechado > 0) partes.push(`${lancamentosDiretos.mesFechado} não lançado(s) em movimentações: mês contábil fechado`);
      if (lancamentosDiretos.falharam > 0) partes.push(`${lancamentosDiretos.falharam} erro(s) ao lançar em movimentações`);

      setMensagem({
        tipo: "sucesso",
        texto: partes.length > 0 ? partes.join(" · ") : "Nenhum lançamento pendente casou com baixa automática ou regras ativas.",
      });
      await refrescarTudo();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao reprocessar." });
    } finally {
      setReprocessando(false);
    }
  }

  // ---------- Importar ----------

  async function handleCriarConta() {
    if (!novaContaApelido.trim() && !novaContaNumero.trim()) {
      setMensagem({ tipo: "erro", texto: "Informe ao menos o apelido ou o número da conta." });
      return;
    }
    setCriandoConta(true);
    setMensagem(null);
    const { data, error } = await supabase
      .from("extrato_conta")
      .insert({
        banco: novaContaBanco,
        apelido: novaContaApelido.trim() || null,
        agencia: novaContaAgencia.trim() || null,
        conta: novaContaNumero.trim() || null,
      })
      .select()
      .single();
    setCriandoConta(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao criar conta: " + error.message });
      return;
    }
    setContas((prev) => [...prev, data as Conta]);
    setContaImportId((data as Conta).id);
    setMostrarNovaConta(false);
    setNovaContaApelido("");
    setNovaContaAgencia("");
    setNovaContaNumero("");
    setMensagem({ tipo: "sucesso", texto: "Conta criada." });
  }

  async function handleImportar() {
    setMensagem(null);
    setResumoImportacao(null);

    if (!arquivo) {
      setMensagem({ tipo: "erro", texto: "Selecione um arquivo .ofx." });
      return;
    }
    if (!contaImportId) {
      setMensagem({ tipo: "erro", texto: "Selecione a conta bancária do extrato." });
      return;
    }
    if (!arquivo.name.toLowerCase().endsWith(".ofx")) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${arquivo.name}" rejeitado: apenas .ofx é aceito.` });
      return;
    }
    if (arquivo.size > 5 * 1024 * 1024) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${arquivo.name}" rejeitado: maior que 5 MB.` });
      return;
    }

    setImportando(true);
    try {
      const bytes = new Uint8Array(await arquivo.arrayBuffer());
      const texto = decodificarOfx(bytes, arquivo.name);
      const parsed = parseOfx(texto, arquivo.name);

      const { data: { user } } = await supabase.auth.getUser();

      // Evita duplicar Pix de fim de semana/feriado já importados via relatório
      // Pix com a data certa — o OFX traz o "eco" desses lançamentos carimbado
      // com a data do próximo dia útil.
      //
      // A consulta é limitada a uma janela de datas ao redor do próprio arquivo
      // .ofx (em vez de todo o histórico da conta) para não esbarrar no limite
      // padrão de linhas do PostgREST em contas com muito Pix acumulado — o mesmo
      // tipo de bug corrigido no commit 693a921. `calcularCobertura` só casa
      // lançamentos existentes com `data <= candidato.data` dentro de uma janela
      // de JANELA_DIAS dias, então nada fora desse intervalo poderia casar de
      // qualquer forma. `parseOfx` já garante `transacoes.length > 0` (lança
      // OfxParseError caso contrário), então os reduces abaixo são seguros.
      const JANELA_DIAS = 5; // deve bater com JANELA_DIAS em lib/cobertura-pix.ts
      const datasTransacoes = parsed.transacoes.map((t) => t.data);
      const dataMaxima = datasTransacoes.reduce((max, d) => (d > max ? d : max));
      const dataMinimaArquivo = datasTransacoes.reduce((min, d) => (d < min ? d : min));
      const dataMinima = new Date(
        new Date(dataMinimaArquivo + "T00:00:00Z").getTime() - JANELA_DIAS * 24 * 60 * 60 * 1000
      )
        .toISOString()
        .slice(0, 10);

      // O pool de cobertura tem que conter SÓ linhas que vieram do relatório Pix
      // (que carregam a data real do Pix). Uma linha vinda de um .ofx anterior
      // não pode cobrir nada: ela já tem a data do banco, e deixá-la no pool faz
      // uma venda nova e legítima de mesmo valor dentro da janela ser descartada
      // sem nunca ser gravada — perda silenciosa de receita.
      //
      // O fitid separa as duas origens: o relatório Pix grava o EndToEndId real
      // ("E" + resto, ex. E0000000020260809145541723483416) ou o sintético
      // "PIXREL:<data>:<valor>:<ocorrencia>"; o FITID do .ofx do Santander é
      // puramente numérico (conta + timestamp do export + índice), então nunca
      // começa com letra e nunca cai neste filtro.
      const { data: existentesPix, error: erroExistentes } = await supabase
        .from("extrato_lancamento")
        .select("id, data_lancamento, valor, descricao_normalizada")
        .eq("conta_id", contaImportId)
        .ilike("descricao_normalizada", "%pix recebido%")
        .or("fitid.like.E%,fitid.like.PIXREL:%")
        .gte("data_lancamento", dataMinima)
        .lte("data_lancamento", dataMaxima);
      if (erroExistentes) throw new Error(erroExistentes.message);

      const candidatosCobertura: CandidatoOfx[] = parsed.transacoes.map((t, indice) => ({
        indice,
        data: t.data,
        valor: t.valor,
        descricaoNormalizada: t.descricaoNormalizada,
      }));
      const cobertura = calcularCobertura(candidatosCobertura, (existentesPix ?? []) as LancamentoExistentePix[]);
      const indicesCobertosSet = new Set(cobertura.indicesCobertos);
      const cobertos = cobertura.indicesCobertos.length;

      const linhas = parsed.transacoes
        .filter((_, indice) => !indicesCobertosSet.has(indice))
        .map((t) => ({
          conta_id: contaImportId,
          fitid: t.fitid,
          data_lancamento: t.data,
          valor: t.valor,
          tipo: t.tipo,
          descricao: t.descricao,
          descricao_normalizada: t.descricaoNormalizada,
          ocorrencia: t.ocorrencia,
          status: "nao_classificado" as const,
        }));

      // O FITID do Santander muda a cada export (é derivado do horário do export,
      // não da transação), então a deduplicação usa a chave natural
      // (conta + data + valor + descrição + ocorrência) em vez do FITID.
      const { data: inseridos, error: erroUpsert } = await supabase
        .from("extrato_lancamento")
        .upsert(linhas, { onConflict: "conta_id,data_lancamento,valor,descricao_normalizada,ocorrencia", ignoreDuplicates: true })
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento");

      if (erroUpsert) throw new Error(erroUpsert.message);

      const novas = inseridos?.length ?? 0;
      const duplicadas = linhas.length - novas;

      const { error: erroImportacao } = await supabase.from("extrato_importacao").insert({
        conta_id: contaImportId,
        nome_arquivo: arquivo.name,
        periodo_inicio: parsed.conta.periodoInicio,
        periodo_fim: parsed.conta.periodoFim,
        qtd_linhas: parsed.transacoes.length,
        qtd_novas: novas,
        qtd_duplicadas: duplicadas,
        importado_por: user?.id ?? null,
      });
      if (erroImportacao) throw new Error(erroImportacao.message);

      let baixasAuto = { baixados: 0, ambiguos: 0, duplicatas: 0, mesFechado: 0, idsBaixados: new Set<string>(), idsAmbiguos: new Set<string>(), idsDuplicatas: new Set<string>() };
      if (inseridos && inseridos.length > 0) {
        baixasAuto = await processarBaixasAutomaticas(inseridos as LancamentoParaBaixa[]);
      }

      let classificadosAuto = 0;
      let lancamentosDiretos = { lancados: 0, mesFechado: 0, falharam: 0 };
      if (inseridos && inseridos.length > 0) {
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter(
          (l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id) && !baixasAuto.idsDuplicatas.has(l.id)
        );
        if (paraClassificar.length > 0) {
          const resultadosRegra = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
          classificadosAuto = resultadosRegra.length;
          lancamentosDiretos = await processarLancamentosDiretos(paraClassificar, resultadosRegra);
        }
      }

      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, baixados: baixasAuto.baixados, ambiguos: baixasAuto.ambiguos, duplicatas: baixasAuto.duplicatas, mesFechado: baixasAuto.mesFechado, movimentacoesLancadas: lancamentosDiretos.lancados, movimentacoesMesFechado: lancamentosDiretos.mesFechado, movimentacoesFalharam: lancamentosDiretos.falharam, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (baixasAuto.baixados > 0 ? ` · ${baixasAuto.baixados} baixado(s) automaticamente` : "") +
          (baixasAuto.ambiguos > 0 ? ` · ${baixasAuto.ambiguos} ambígua(s) (revisar)` : "") +
          (baixasAuto.duplicatas > 0 ? ` · ${baixasAuto.duplicatas} provável(is) duplicata(s) (revisar)` : "") +
          (baixasAuto.mesFechado > 0 ? ` · ${baixasAuto.mesFechado} não baixada(s): mês contábil fechado` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : "") +
          (lancamentosDiretos.lancados > 0 ? ` · ${lancamentosDiretos.lancados} lançada(s) em movimentações` : "") +
          (lancamentosDiretos.mesFechado > 0 ? ` · ${lancamentosDiretos.mesFechado} não lançada(s): mês contábil fechado` : "") +
          (lancamentosDiretos.falharam > 0 ? ` · ${lancamentosDiretos.falharam} erro(s) ao lançar em movimentações` : ""),
      });
      setArquivo(null);
      if (inputArquivoRef.current) inputArquivoRef.current.value = "";
      await refrescarTudo();
    } catch (e) {
      const texto = e instanceof OfxParseError || e instanceof Error ? e.message : "Erro inesperado ao importar o arquivo.";
      setMensagem({ tipo: "erro", texto });
    } finally {
      setImportando(false);
    }
  }

  async function handleImportarRelatorioPix() {
    setMensagem(null);
    setResumoImportacaoPix(null);

    if (!arquivoPix) {
      setMensagem({ tipo: "erro", texto: "Selecione o arquivo do relatório Pix (.xlsx)." });
      return;
    }
    if (!contaImportId) {
      setMensagem({ tipo: "erro", texto: "Selecione a conta bancária." });
      return;
    }
    if (!arquivoPix.name.toLowerCase().endsWith(".xlsx")) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${arquivoPix.name}" rejeitado: apenas .xlsx é aceito.` });
      return;
    }
    if (arquivoPix.size > 5 * 1024 * 1024) {
      setMensagem({ tipo: "erro", texto: `Arquivo "${arquivoPix.name}" rejeitado: maior que 5 MB.` });
      return;
    }

    setImportandoPix(true);
    try {
      const bytes = new Uint8Array(await arquivoPix.arrayBuffer());
      const parsed = await parseRelatorioPix(bytes, arquivoPix.name);

      const { data: { user } } = await supabase.auth.getUser();

      const linhas = parsed.linhas.map((l) => ({
        conta_id: contaImportId,
        fitid: l.idTransacao ?? `PIXREL:${l.data}:${l.valor}:${l.ocorrencia}`,
        data_lancamento: l.data,
        valor: l.valor,
        tipo: "CREDIT",
        descricao: l.descricao,
        descricao_normalizada: l.descricaoNormalizada,
        ocorrencia: l.ocorrencia,
        status: "nao_classificado" as const,
      }));

      const { data: inseridos, error: erroUpsert } = await supabase
        .from("extrato_lancamento")
        .upsert(linhas, { onConflict: "conta_id,data_lancamento,valor,descricao_normalizada,ocorrencia", ignoreDuplicates: true })
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento");

      if (erroUpsert) throw new Error(erroUpsert.message);

      const novas = inseridos?.length ?? 0;
      const duplicadas = linhas.length - novas;

      const datas = parsed.linhas.map((l) => l.data);
      const { error: erroImportacao } = await supabase.from("extrato_importacao").insert({
        conta_id: contaImportId,
        nome_arquivo: arquivoPix.name,
        periodo_inicio: datas.length > 0 ? datas.reduce((min, d) => (d < min ? d : min)) : null,
        periodo_fim: datas.length > 0 ? datas.reduce((max, d) => (d > max ? d : max)) : null,
        qtd_linhas: linhas.length,
        qtd_novas: novas,
        qtd_duplicadas: duplicadas,
        importado_por: user?.id ?? null,
      });
      if (erroImportacao) throw new Error(erroImportacao.message);

      let classificadosAuto = 0;
      let lancamentosDiretosPix = { lancados: 0, mesFechado: 0, falharam: 0 };
      if (inseridos && inseridos.length > 0) {
        const resultadosRegra = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
        classificadosAuto = resultadosRegra.length;
        lancamentosDiretosPix = await processarLancamentosDiretos(inseridos as LancamentoParaBaixa[], resultadosRegra);
      }

      setResumoImportacaoPix({ lidas: linhas.length, novas, duplicadas, movimentacoesLancadas: lancamentosDiretosPix.lancados, movimentacoesMesFechado: lancamentosDiretosPix.mesFechado, movimentacoesFalharam: lancamentosDiretosPix.falharam, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${linhas.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : "") +
          (lancamentosDiretosPix.lancados > 0 ? ` · ${lancamentosDiretosPix.lancados} lançada(s) em movimentações` : "") +
          (lancamentosDiretosPix.mesFechado > 0 ? ` · ${lancamentosDiretosPix.mesFechado} não lançada(s): mês contábil fechado` : "") +
          (lancamentosDiretosPix.falharam > 0 ? ` · ${lancamentosDiretosPix.falharam} erro(s) ao lançar em movimentações` : ""),
      });
      setArquivoPix(null);
      if (inputArquivoPixRef.current) inputArquivoPixRef.current.value = "";
      await refrescarTudo();
    } catch (e) {
      const texto = e instanceof RelatorioPixParseError || e instanceof Error ? e.message : "Erro inesperado ao importar o relatório Pix.";
      setMensagem({ tipo: "erro", texto });
    } finally {
      setImportandoPix(false);
    }
  }

  // ---------- Classificação manual ----------

  async function handleClassificarManual(lancamento: Lancamento, categoria: string) {
    if (!categoria.trim()) return;
    setAcaoLancamentoId(lancamento.id);
    setMensagem(null);
    const { data: { user } } = await supabase.auth.getUser();
    // Condicional a status ainda ser "nao_classificado" -- fecha a corrida na
    // origem: se duas abas tentarem classificar o MESMO lançamento quase ao
    // mesmo tempo, só a primeira realmente muda uma linha; a segunda vê
    // linhasAtualizadas vazio e nem chega a chamar lancarMovimentacaoDireta,
    // evitando duas movimentações reais para o mesmo débito/crédito bancário.
    const { data: linhasAtualizadas, error } = await supabase
      .from("extrato_lancamento")
      .update({
        categoria: categoria.trim(),
        status: "classificado",
        classificado_em: new Date().toISOString(),
        classificado_por: user?.id ?? null,
        regra_id: null,
        contas_pagar_duplicatas: null,
      })
      .eq("id", lancamento.id)
      .eq("status", "nao_classificado")
      .select("id");
    setAcaoLancamentoId(null);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao classificar: " + error.message });
      return;
    }
    if (!linhasAtualizadas || linhasAtualizadas.length === 0) {
      setMensagem({ tipo: "erro", texto: "Este lançamento já foi classificado (por outra aba ou automaticamente) — atualizando a lista." });
      await Promise.all([carregarLancamentos(), carregarResumo()]);
      return;
    }

    const { entrada, saida } = await carregarMapasCategoria();
    const resultadoLancamento = await lancarMovimentacaoDireta(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento, valor: lancamento.valor, descricao_normalizada: lancamento.descricao_normalizada },
      categoria.trim(),
      entrada,
      saida
    );
    if (resultadoLancamento === "mes_fechado") {
      setMensagem({
        tipo: "erro",
        texto: `Classificado, mas não lançado em Movimentações: ${formatarData(lancamento.data_lancamento)} está num mês contábil já fechado.`,
      });
    } else if (resultadoLancamento === "falhou") {
      setMensagem({
        tipo: "erro",
        texto: "Classificado, mas houve um erro ao lançar a movimentação. Tente novamente ou lance manualmente.",
      });
    }

    setCategoriaEmEdicao((prev) => {
      const cp = { ...prev };
      delete cp[lancamento.id];
      return cp;
    });
    await Promise.all([carregarLancamentos(), carregarResumo()]);
    setTrechoRegra(lancamento.descricao_normalizada);
    setEscopoContaRegra(true);
    setSugerirRegraPara({ lancamento, categoria: categoria.trim() });
  }

  async function handleAbrirResolucaoAmbigua(lancamento: Lancamento) {
    if (!lancamento.contas_pagar_candidatas || lancamento.contas_pagar_candidatas.length === 0) return;
    setCarregandoCandidatos(true);
    // Só contas AINDA pendentes podem ser oferecidas: uma delas pode ter sido
    // paga por outro caminho (ou por outra aba) depois que a ambiguidade foi
    // registrada, e escolher uma conta já paga só resultaria em erro.
    const { data, error } = await supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, data_vencimento, categoria_id")
      .in("id", lancamento.contas_pagar_candidatas)
      .eq("status", "pendente");
    setCarregandoCandidatos(false);
    if (error || !data) {
      setMensagem({ tipo: "erro", texto: "Erro ao carregar as contas candidatas: " + (error?.message ?? "") });
      return;
    }
    if (data.length === 0) {
      setMensagem({ tipo: "erro", texto: "Nenhuma das contas candidatas continua pendente — todas já foram pagas por outro caminho. Use 'Reprocessar regras' para reavaliar este lançamento." });
      return;
    }
    setResolvendoAmbiguo({
      lancamento,
      candidatos: data as { id: string; fornecedor: string; valor: number; data_vencimento: string; categoria_id: string | null }[],
    });
  }

  async function handleResolverBaixaAmbigua(contaPagarId: string) {
    if (!podeEscrever) return;
    if (!resolvendoAmbiguo) return;
    const conta = resolvendoAmbiguo.candidatos.find((c) => c.id === contaPagarId);
    if (!conta) return;
    setResolvendoBaixaId(contaPagarId);

    let categoriaNome = "Contas a pagar";
    if (conta.categoria_id) {
      const { data: categoria } = await supabase.from("categorias_saida").select("nome").eq("id", conta.categoria_id).single();
      if (categoria?.nome) categoriaNome = categoria.nome as string;
    }

    const resultadoEscrita = await baixarContaPagar(
      { id: resolvendoAmbiguo.lancamento.id, data_lancamento: resolvendoAmbiguo.lancamento.data_lancamento },
      { id: conta.id, fornecedor: conta.fornecedor, valor: Number(conta.valor), categoria_id: conta.categoria_id },
      categoriaNome,
      "manual"
    );

    setResolvendoBaixaId(null);
    if (resultadoEscrita === "mes_fechado") {
      setMensagem({
        tipo: "erro",
        texto: `Não foi possível confirmar a baixa: ${formatarData(resolvendoAmbiguo.lancamento.data_lancamento)} está num mês contábil já fechado.`,
      });
      return;
    }
    if (resultadoEscrita !== "ok") {
      setMensagem({ tipo: "erro", texto: "Não foi possível confirmar a baixa — a conta pode já ter sido paga, ou este lançamento já foi baixado em outra aba." });
      await Promise.all([carregarLancamentos(), carregarResumo()]);
      return;
    }
    setResolvendoAmbiguo(null);
    setMensagem({ tipo: "sucesso", texto: `Baixa confirmada: ${conta.fornecedor}.` });
    await Promise.all([carregarLancamentos(), carregarResumo()]);
  }

  function fecharResolucaoAmbigua() {
    setResolvendoAmbiguo(null);
  }

  async function handleAbrirDuplicata(lancamento: Lancamento) {
    if (!lancamento.contas_pagar_duplicatas || lancamento.contas_pagar_duplicatas.length === 0) return;
    setCarregandoDuplicata(true);
    const { data, error } = await supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, data_pagamento")
      .in("id", lancamento.contas_pagar_duplicatas)
      .eq("status", "pago");
    setCarregandoDuplicata(false);
    if (error || !data) {
      setMensagem({ tipo: "erro", texto: "Erro ao carregar as contas já pagas: " + (error?.message ?? "") });
      return;
    }
    if (data.length === 0) {
      setMensagem({ tipo: "erro", texto: "Nenhuma das contas sinalizadas continua com status pago — use 'Reprocessar regras' para reavaliar este lançamento." });
      return;
    }
    setResolvendoDuplicata({
      lancamento,
      candidatos: data as { id: string; fornecedor: string; valor: number; data_pagamento: string | null }[],
    });
  }

  async function handleDescartarDuplicata() {
    if (!resolvendoDuplicata) return;
    setResolvendoDuplicata(null);
    await handleIgnorar(resolvendoDuplicata.lancamento);
  }

  function fecharDuplicata() {
    setResolvendoDuplicata(null);
  }

  async function handleIgnorar(lancamento: Lancamento) {
    setAcaoLancamentoId(lancamento.id);
    setMensagem(null);
    const { error } = await supabase
      .from("extrato_lancamento")
      .update({ status: "ignorado", contas_pagar_duplicatas: null })
      .eq("id", lancamento.id);
    setAcaoLancamentoId(null);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao ignorar lançamento: " + error.message });
      return;
    }
    await Promise.all([carregarLancamentos(), carregarResumo()]);
  }

  // "Revisado" é um estado interno do staging /extrato — nunca grava em
  // movimentacoes/contas_pagar. Marca que o usuário já conferiu visualmente a
  // classificação daquele dia. Só pode confirmar se não sobrar pendente no dia.
  async function handleConfirmarDia(dia: ResumoDia) {
    if (!podeEscrever || dia.pendentes > 0) return;
    setConfirmandoDia(dia.data);
    setMensagem(null);
    const novoValor = !dia.revisado;
    const { error } = await supabase.from("extrato_lancamento").update({ revisado: novoValor }).in("id", dia.classificadosIds);
    setConfirmandoDia(null);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao confirmar dia: " + error.message });
      return;
    }
    setMensagem({ tipo: "sucesso", texto: novoValor ? `Dia ${formatarData(dia.data)} confirmado.` : `Confirmação do dia ${formatarData(dia.data)} desfeita.` });
    await carregarLancamentos();
  }

  async function handleCriarRegraSugerida() {
    if (!sugerirRegraPara || !trechoRegra.trim()) return;
    setCriandoRegraSugerida(true);
    setMensagem(null);
    const { error } = await supabase.from("extrato_regra").insert({
      nome: `Auto: ${trechoRegra.trim()}`,
      tipo_match: "contem",
      padrao: trechoRegra.trim(),
      conta_id: escopoContaRegra ? sugerirRegraPara.lancamento.conta_id : null,
      categoria: sugerirRegraPara.categoria,
      prioridade: 100,
      ativa: true,
    });
    if (error) {
      setCriandoRegraSugerida(false);
      setMensagem({ tipo: "erro", texto: "Erro ao criar regra: " + error.message });
      return;
    }
    setSugerirRegraPara(null);
    await handleReprocessar();
    setCriandoRegraSugerida(false);
  }

  // ---------- CRUD de regras ----------

  function abrirNovaRegra() {
    setEditandoRegraId(null);
    setFormRegra(REGRA_FORM_INICIAL);
    setMostrarFormRegra(true);
  }

  function abrirEdicaoRegra(r: Regra) {
    setEditandoRegraId(r.id);
    setFormRegra({
      nome: r.nome,
      tipo_match: r.tipo_match,
      padrao: r.padrao,
      conta_id: r.conta_id ?? "",
      valor_min: r.valor_min != null ? String(r.valor_min) : "",
      valor_max: r.valor_max != null ? String(r.valor_max) : "",
      categoria: r.categoria,
      prioridade: String(r.prioridade),
      ativa: r.ativa,
    });
    setMostrarFormRegra(true);
  }

  async function handleSalvarRegra() {
    if (!formRegra.nome.trim() || !formRegra.padrao.trim() || !formRegra.categoria.trim()) {
      setMensagem({ tipo: "erro", texto: "Preencha nome, padrão e categoria da regra." });
      return;
    }
    setSalvandoRegra(true);
    setMensagem(null);
    const payload = {
      nome: formRegra.nome.trim(),
      tipo_match: formRegra.tipo_match,
      padrao: formRegra.padrao.trim(),
      conta_id: formRegra.conta_id || null,
      valor_min: formRegra.valor_min !== "" ? Number(formRegra.valor_min) : null,
      valor_max: formRegra.valor_max !== "" ? Number(formRegra.valor_max) : null,
      categoria: formRegra.categoria.trim(),
      prioridade: Number(formRegra.prioridade) || 100,
      ativa: formRegra.ativa,
    };
    const { error } = editandoRegraId
      ? await supabase.from("extrato_regra").update(payload).eq("id", editandoRegraId)
      : await supabase.from("extrato_regra").insert(payload);
    setSalvandoRegra(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao salvar regra: " + error.message });
      return;
    }
    setMensagem({ tipo: "sucesso", texto: editandoRegraId ? "Regra atualizada." : "Regra criada." });
    setFormRegra(REGRA_FORM_INICIAL);
    setEditandoRegraId(null);
    setMostrarFormRegra(false);
    await carregarRegras();
  }

  async function handleAlternarAtiva(r: Regra) {
    const { error } = await supabase.from("extrato_regra").update({ ativa: !r.ativa }).eq("id", r.id);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao atualizar regra: " + error.message });
      return;
    }
    await carregarRegras();
  }

  async function handleExcluirRegra(r: Regra) {
    if (!confirm(`Excluir a regra "${r.nome}"? Lançamentos já classificados por ela não serão alterados.`)) return;
    const { error } = await supabase.from("extrato_regra").delete().eq("id", r.id);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao excluir regra: " + error.message });
      return;
    }
    await carregarRegras();
  }

  const percentualAutomatico = resumo.total > 0 ? Math.round((resumo.automaticos / resumo.total) * 100) : 0;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-bold text-[var(--color-text)]">Extrato Bancário (OFX)</h1>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          Fase 1 do projeto de conciliação — a classificação por categoria e as regras continuam sendo staging, isoladas do sistema
          principal. <b>Exceção:</b> a baixa automática de contas a pagar grava de verdade em Contas a Pagar e Movimentações.
        </p>
      </div>

      {mensagem && (
        <div
          className={`mb-4 px-4 py-3 rounded-xl text-sm font-medium border ${
            mensagem.tipo === "sucesso" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {mensagem.tipo === "sucesso" ? "✅ " : "⚠️ "}
          {mensagem.texto}
        </div>
      )}

      <div className="flex gap-1 mb-6 border-b border-[var(--color-border)]">
        {[
          { id: "importar", label: "📥 Importar" },
          { id: "lancamentos", label: "📄 Lançamentos" },
          { id: "regras", label: "⚙️ Regras" },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setAba(t.id as typeof aba)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition ${
              aba === t.id ? "border-emerald-500 text-emerald-600" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!podeEscrever && (
        <div className="mb-4 px-4 py-2.5 rounded-xl text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
          👁️ Seu perfil tem acesso somente leitura nesta área.
        </div>
      )}

      {aba === "importar" && (
        <div>
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-xl">
            <h2 className="font-semibold text-sm mb-4">Importar extrato .ofx</h2>

            <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Conta bancária</label>
            <div className="flex gap-2 mb-4">
              <select
                value={contaImportId}
                onChange={(e) => setContaImportId(e.target.value)}
                disabled={!podeEscrever}
                className="flex-1 px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
              >
                <option value="">Selecione...</option>
                {contas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {nomeConta(c)}
                  </option>
                ))}
              </select>
              {podeEscrever && (
                <button
                  type="button"
                  onClick={() => setMostrarNovaConta((v) => !v)}
                  className="px-3 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-medium hover:bg-[var(--hover-bg)]"
                >
                  + Nova
                </button>
              )}
            </div>

            {mostrarNovaConta && (
              <div className="mb-4 p-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] space-y-2">
                <div className="flex gap-2">
                  <select
                    value={novaContaBanco}
                    onChange={(e) => setNovaContaBanco(e.target.value)}
                    className="px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs"
                  >
                    <option value="santander">Santander</option>
                    <option value="inter">Inter</option>
                    <option value="outro">Outro</option>
                  </select>
                  <input
                    placeholder="Apelido (ex: Conta PJ)"
                    value={novaContaApelido}
                    onChange={(e) => setNovaContaApelido(e.target.value)}
                    className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs"
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    placeholder="Agência"
                    value={novaContaAgencia}
                    onChange={(e) => setNovaContaAgencia(e.target.value)}
                    className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs"
                  />
                  <input
                    placeholder="Número da conta"
                    value={novaContaNumero}
                    onChange={(e) => setNovaContaNumero(e.target.value)}
                    className="flex-1 px-2 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-xs"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleCriarConta}
                  disabled={criandoConta}
                  className="w-full px-3 py-2 rounded-lg bg-emerald-500 text-white text-xs font-semibold disabled:opacity-60"
                >
                  {criandoConta ? "Criando..." : "Criar conta"}
                </button>
              </div>
            )}

            <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Arquivo .ofx (máx 5 MB)</label>
            <input
              ref={inputArquivoRef}
              type="file"
              accept=".ofx"
              disabled={!podeEscrever}
              onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
              className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:text-xs file:font-semibold"
            />

            <button
              type="button"
              onClick={handleImportar}
              disabled={!podeEscrever || importando || !arquivo || !contaImportId}
              className="w-full px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {importando && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
              {importando ? "Importando..." : "Importar extrato"}
            </button>

            {resumoImportacao && (
              <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
                <p className="font-semibold">
                  {resumoImportacao.lidas} lidas · {resumoImportacao.novas} novas · {resumoImportacao.duplicadas} já existentes
                  {resumoImportacao.cobertos > 0 && ` · ${resumoImportacao.cobertos} já cobertas pelo relatório Pix`}
                </p>
                {(resumoImportacao.baixados > 0 || resumoImportacao.ambiguos > 0) && (
                  <p className="mt-1 font-semibold">
                    {resumoImportacao.baixados} lançamento(s) de saída baixados automaticamente em Contas a Pagar
                    {resumoImportacao.ambiguos > 0 && ` · ${resumoImportacao.ambiguos} ambíguo(s) — revisar na aba Lançamentos`}
                  </p>
                )}
                {resumoImportacao.duplicatas > 0 && (
                  <p className="mt-1 font-semibold text-orange-700">
                    {resumoImportacao.duplicatas} lançamento(s) sinalizado(s) como provável duplicata — revisar na aba Lançamentos.
                  </p>
                )}
                {resumoImportacao.mesFechado > 0 && (
                  <p className="mt-1 font-semibold text-amber-700">
                    {resumoImportacao.mesFechado} lançamento(s) casaram com uma conta a pagar mas NÃO foram baixados: a data do
                    pagamento cai num mês contábil já fechado. Reabra o mês (ou baixe a conta manualmente) se for o caso.
                  </p>
                )}
                {resumoImportacao.movimentacoesLancadas > 0 && (
                  <p className="mt-1 font-semibold">
                    {resumoImportacao.movimentacoesLancadas} lançamento(s) lançados em Movimentações
                  </p>
                )}
                {resumoImportacao.movimentacoesMesFechado > 0 && (
                  <p className="mt-1 font-semibold text-amber-700">
                    {resumoImportacao.movimentacoesMesFechado} lançamento(s) classificados mas NÃO lançados em Movimentações: mês contábil já fechado.
                  </p>
                )}
                {resumoImportacao.movimentacoesFalharam > 0 && (
                  <p className="mt-1 font-semibold text-red-700">
                    {resumoImportacao.movimentacoesFalharam} lançamento(s) classificados mas com ERRO ao lançar em Movimentações — reprocesse ou lance manualmente.
                  </p>
                )}
                {resumoImportacao.avisos.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-amber-700">
                    {resumoImportacao.avisos.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-xl mt-6">
            <h2 className="font-semibold text-sm mb-1">Importar relatório Pix (fim de semana/feriado)</h2>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              O extrato .ofx nunca posta em sábado/domingo/feriado — tudo cai no próximo dia útil. Suba aqui o relatório Pix
              (Excel) do Santander pra registrar esses lançamentos já com a data certa. Depois, ao importar o .ofx normal, o
              sistema reconhece e não duplica o que já foi coberto por aqui.
            </p>

            <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">
              Arquivo do relatório Pix (.xlsx, máx 5 MB)
            </label>
            <input
              ref={inputArquivoPixRef}
              type="file"
              accept=".xlsx"
              disabled={!podeEscrever}
              onChange={(e) => setArquivoPix(e.target.files?.[0] ?? null)}
              className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-xs file:font-semibold"
            />

            <button
              type="button"
              onClick={handleImportarRelatorioPix}
              disabled={!podeEscrever || importandoPix || !arquivoPix || !contaImportId}
              className="w-full px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {importandoPix && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
              {importandoPix ? "Importando..." : "Importar relatório Pix"}
            </button>

            {resumoImportacaoPix && (
              <div className="mt-4 p-3 rounded-xl bg-blue-50 border border-blue-200 text-xs text-blue-800">
                <p className="font-semibold">
                  {resumoImportacaoPix.lidas} lidas · {resumoImportacaoPix.novas} novas · {resumoImportacaoPix.duplicadas} já existentes
                </p>
                {resumoImportacaoPix.movimentacoesLancadas > 0 && (
                  <p className="mt-1 font-semibold">
                    {resumoImportacaoPix.movimentacoesLancadas} lançamento(s) lançados em Movimentações
                  </p>
                )}
                {resumoImportacaoPix.movimentacoesMesFechado > 0 && (
                  <p className="mt-1 font-semibold text-amber-700">
                    {resumoImportacaoPix.movimentacoesMesFechado} lançamento(s) classificados mas NÃO lançados em Movimentações: mês contábil já fechado.
                  </p>
                )}
                {resumoImportacaoPix.movimentacoesFalharam > 0 && (
                  <p className="mt-1 font-semibold text-red-700">
                    {resumoImportacaoPix.movimentacoesFalharam} lançamento(s) classificados mas com ERRO ao lançar em Movimentações — reprocesse ou lance manualmente.
                  </p>
                )}
                {resumoImportacaoPix.avisos.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-amber-700">
                    {resumoImportacaoPix.avisos.map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {aba === "lancamentos" && (
        <div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3">
              <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">Total</p>
              <p className="text-lg font-bold">{resumo.total}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3">
              <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">Classificados</p>
              <p className="text-lg font-bold text-emerald-600">{resumo.classificados}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3">
              <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">Não classificados</p>
              <p className="text-lg font-bold text-amber-600">{resumo.naoClassificados}</p>
            </div>
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3">
              <p className="text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">% Automático</p>
              <p className="text-lg font-bold text-blue-600">{percentualAutomatico}%</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-4 items-center">
            <select
              value={filtroContaId}
              onChange={(e) => setFiltroContaId(e.target.value)}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs"
            >
              <option value="">Todas as contas</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {nomeConta(c)}
                </option>
              ))}
            </select>
            <select
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value as typeof filtroStatus)}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs"
            >
              <option value="todos">Todos os status</option>
              <option value="nao_classificado">Não classificados</option>
              <option value="classificado">Classificados</option>
              <option value="ignorado">Ignorados</option>
            </select>
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] px-1">
              <input type="checkbox" checked={ocultarRevisados} onChange={(e) => setOcultarRevisados(e.target.checked)} />
              Ocultar dias já revisados
            </label>
            <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] px-1">
              <input type="checkbox" checked={ocultarIgnorados} onChange={(e) => setOcultarIgnorados(e.target.checked)} />
              Ocultar ignorados
            </label>
            {podeEscrever && (
              <button
                type="button"
                onClick={handleReprocessar}
                disabled={reprocessando}
                className="ml-auto px-3 py-2 rounded-lg bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold disabled:opacity-60 flex items-center gap-2"
              >
                {reprocessando && <span className="w-3 h-3 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin" />}
                {reprocessando ? "Reprocessando..." : "🔁 Reprocessar regras"}
              </button>
            )}
          </div>

          {carregandoLancamentos ? (
            <div className="skeleton h-40 rounded-xl" />
          ) : lancamentos.length === 0 ? (
            <EmptyState variant="search" title="Nenhum lançamento" description="Importe um extrato .ofx na aba Importar para começar." compact />
          ) : (
            <div>
              {lancamentos.length >= LIMITE_LANCAMENTOS && (
                <p className="mb-2 text-[10px] text-[var(--color-text-muted)]">
                  Mostrando apenas os últimos {LIMITE_LANCAMENTOS} lançamentos — o dia mais antigo pode estar incompleto.
                </p>
              )}
              <div className="space-y-2">
                {resumoPorDia.map((dia) => {
                  const expandido = diaExpandido === dia.data;
                  const itensDoDia = lancamentos
                    .filter((l) => l.data_lancamento === dia.data)
                    .sort((a, b) => a.descricao.localeCompare(b.descricao, "pt-BR"));
                  return (
                    <div
                      key={dia.data}
                      className={`bg-[var(--color-surface)] border rounded-xl overflow-hidden transition-colors ${
                        dia.revisado ? "border-emerald-300" : "border-[var(--color-border)]"
                      }`}
                    >
                      <div
                        onClick={() => setDiaExpandido(expandido ? null : dia.data)}
                        className="p-3 cursor-pointer hover:bg-[var(--hover-bg)] transition-colors"
                      >
                        <div className="flex justify-between items-center gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] text-[var(--color-text-muted)] shrink-0">{expandido ? "▾" : "▸"}</span>
                            <span className="text-xs font-semibold whitespace-nowrap">
                              {dia.revisado && "✅ "}
                              {formatarData(dia.data)}
                            </span>
                            {dia.pendentes > 0 && (
                              <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-semibold whitespace-nowrap">
                                {dia.pendentes} pendente{dia.pendentes > 1 ? "s" : ""}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`text-xs font-bold ${dia.totalDia < 0 ? "text-red-600" : "text-emerald-600"}`}>
                              {formatarMoeda(dia.totalDia)}
                            </span>
                            {podeEscrever && (
                              <button
                                type="button"
                                disabled={dia.pendentes > 0 || confirmandoDia === dia.data}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleConfirmarDia(dia);
                                }}
                                title={dia.pendentes > 0 ? "Classifique todos os lançamentos pendentes deste dia antes de confirmar" : "Marca este dia como revisado (não lança em Movimentações)"}
                                className={`px-2 py-1 rounded-lg text-[10px] font-semibold whitespace-nowrap disabled:opacity-40 ${
                                  dia.revisado ? "bg-emerald-100 text-emerald-700" : "border border-[var(--color-border)] hover:bg-[var(--surface)]"
                                }`}
                              >
                                {confirmandoDia === dia.data ? "..." : dia.revisado ? "✓ Revisado" : "Confirmar dia"}
                              </button>
                            )}
                          </div>
                        </div>
                        {dia.categorias.length > 0 && (
                          <div className="mt-2 space-y-0.5">
                            {dia.categorias.map((c) => (
                              <div key={c.categoria} className="flex justify-between text-[11px] text-[var(--color-text-muted)]">
                                <span>
                                  {c.categoria} <span className="text-[10px]">×{c.quantidade}</span>
                                </span>
                                <span className={c.total < 0 ? "text-red-500" : "text-emerald-600"}>{formatarMoeda(c.total)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {expandido && (
                        <div className="border-t border-[var(--color-border)] overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                                <th className="px-3 py-2 font-semibold">Descrição</th>
                                <th className="px-3 py-2 font-semibold text-right">Valor</th>
                                <th className="px-3 py-2 font-semibold">Categoria</th>
                                <th className="px-3 py-2 font-semibold">Origem</th>
                                <th className="px-3 py-2 font-semibold">Ação</th>
                              </tr>
                            </thead>
                            <tbody>
                              {itensDoDia.map((l) => (
                                <tr key={l.id} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                                  <td className="px-3 py-2 max-w-[240px] truncate" title={l.descricao}>
                                    {l.descricao}
                                  </td>
                                  <td className={`px-3 py-2 text-right whitespace-nowrap font-semibold ${l.valor < 0 ? "text-red-600" : "text-emerald-600"}`}>
                                    {formatarMoeda(l.valor)}
                                  </td>
                                  <td className="px-3 py-2">
                                    {l.categoria ? (
                                      <div className="flex flex-col gap-1 items-start">
                                        <span
                                          className={`px-2 py-0.5 rounded-full text-[9px] font-bold ${
                                            calcularTipoMovimentacao(l.valor) === "entrada" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                                          }`}
                                        >
                                          {calcularTipoMovimentacao(l.valor) === "entrada" ? "Entrada" : "Saída"}
                                        </span>
                                        <span className="px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold whitespace-nowrap">
                                          {l.categoria}
                                        </span>
                                        {l.conta_pagar_id && (
                                          <span className="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[9px] font-semibold whitespace-nowrap">
                                            Baixa automática
                                          </span>
                                        )}
                                        {l.movimentacao_id && (
                                          <span className="px-2 py-0.5 rounded-full bg-purple-50 text-purple-700 border border-purple-200 text-[9px] font-semibold whitespace-nowrap">
                                            Lançado em Movimentações
                                          </span>
                                        )}
                                      </div>
                                    ) : podeEscrever && l.contas_pagar_candidatas && l.contas_pagar_candidatas.length > 0 ? (
                                      <button
                                        type="button"
                                        disabled={carregandoCandidatos}
                                        onClick={() => handleAbrirResolucaoAmbigua(l)}
                                        className="px-2 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold whitespace-nowrap hover:bg-amber-100 disabled:opacity-50"
                                      >
                                        {carregandoCandidatos ? "..." : `Baixa ambígua (${l.contas_pagar_candidatas.length})`}
                                      </button>
                                    ) : podeEscrever && l.contas_pagar_duplicatas && l.contas_pagar_duplicatas.length > 0 ? (
                                      <button
                                        type="button"
                                        disabled={carregandoDuplicata}
                                        onClick={() => handleAbrirDuplicata(l)}
                                        className="px-2 py-1 rounded-full bg-orange-50 text-orange-700 border border-orange-200 text-[10px] font-semibold whitespace-nowrap hover:bg-orange-100 disabled:opacity-50"
                                      >
                                        {carregandoDuplicata ? "..." : `Provável duplicata (${l.contas_pagar_duplicatas.length})`}
                                      </button>
                                    ) : l.status === "ignorado" ? (
                                      <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                                    ) : (
                                      <span className="text-[10px] text-amber-600 font-medium">pendente</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap text-[10px] text-[var(--color-text-muted)]">
                                    {l.status === "ignorado" ? "ignorado" : l.regra_id ? "regra" : l.conta_pagar_id ? "baixa" : l.categoria ? "manual" : "—"}
                                  </td>
                                  <td className="px-3 py-2">
                                    {l.status === "nao_classificado" && podeEscrever ? (
                                      <div className="flex gap-1.5 items-center">
                                        <select
                                          value={categoriaEmEdicao[l.id] ?? ""}
                                          onChange={(e) => setCategoriaEmEdicao((prev) => ({ ...prev, [l.id]: e.target.value }))}
                                          className="w-32 px-2 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px]"
                                        >
                                          <option value="">categoria...</option>
                                          {(calcularTipoMovimentacao(l.valor) === "entrada" ? categoriasEntrada : categoriasSaida).map((c) => (
                                            <option key={c} value={c}>
                                              {c}
                                            </option>
                                          ))}
                                        </select>
                                        <button
                                          type="button"
                                          disabled={!categoriaEmEdicao[l.id]?.trim() || acaoLancamentoId === l.id}
                                          onClick={() => handleClassificarManual(l, categoriaEmEdicao[l.id])}
                                          className="px-2 py-1.5 rounded-lg bg-emerald-500 text-white text-[11px] font-semibold disabled:opacity-50 whitespace-nowrap"
                                        >
                                          {acaoLancamentoId === l.id ? "..." : "Classificar"}
                                        </button>
                                        <button
                                          type="button"
                                          disabled={acaoLancamentoId === l.id}
                                          onClick={() => handleIgnorar(l)}
                                          className="px-2 py-1.5 rounded-lg border border-[var(--color-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)] disabled:opacity-50"
                                        >
                                          Ignorar
                                        </button>
                                      </div>
                                    ) : (
                                      <span className="text-[10px] text-[var(--color-text-muted)]">
                                        {l.classificado_em ? new Date(l.classificado_em).toLocaleDateString("pt-BR") : ""}
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {sugerirRegraPara && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setSugerirRegraPara(null)}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm mb-1">Ensinar uma regra?</h3>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  Aplicar categoria <b>{sugerirRegraPara.categoria}</b> a todos os lançamentos que contenham:
                </p>
                <input
                  value={trechoRegra}
                  onChange={(e) => setTrechoRegra(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-3"
                />
                <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)] mb-4">
                  <input type="checkbox" checked={escopoContaRegra} onChange={(e) => setEscopoContaRegra(e.target.checked)} />
                  Aplicar só a esta conta bancária
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSugerirRegraPara(null)}
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                  >
                    Agora não
                  </button>
                  <button
                    type="button"
                    disabled={criandoRegraSugerida || !trechoRegra.trim()}
                    onClick={handleCriarRegraSugerida}
                    className="flex-1 px-3 py-2 rounded-lg bg-emerald-500 text-white text-xs font-semibold disabled:opacity-60"
                  >
                    {criandoRegraSugerida ? "Criando..." : "Criar regra e aplicar"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {resolvendoAmbiguo && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={fecharResolucaoAmbigua}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm mb-1">Qual conta foi paga?</h3>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  {resolvendoAmbiguo.candidatos.length} contas a pagar têm o mesmo fornecedor e o mesmo valor
                  ({formatarMoeda(Math.abs(resolvendoAmbiguo.lancamento.valor))}) — escolha qual foi paga em{" "}
                  {formatarData(resolvendoAmbiguo.lancamento.data_lancamento)}.
                </p>
                <div className="space-y-2 mb-4">
                  {resolvendoAmbiguo.candidatos.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      disabled={resolvendoBaixaId !== null}
                      onClick={() => handleResolverBaixaAmbigua(c.id)}
                      className="w-full flex justify-between items-center px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs hover:bg-[var(--hover-bg)] disabled:opacity-50 text-left"
                    >
                      <span>
                        <span className="font-semibold">{c.fornecedor}</span>
                        <br />
                        <span className="text-[var(--color-text-muted)]">Vencimento: {formatarData(c.data_vencimento)}</span>
                      </span>
                      <span className="font-semibold">
                        {resolvendoBaixaId === c.id ? "..." : formatarMoeda(c.valor)}
                      </span>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={fecharResolucaoAmbigua}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                >
                  Decidir depois
                </button>
              </div>
            </div>
          )}

          {resolvendoDuplicata && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={fecharDuplicata}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm mb-1">Provável duplicata</h3>
                <p className="text-xs text-[var(--color-text-muted)] mb-3">
                  Este lançamento de {formatarData(resolvendoDuplicata.lancamento.data_lancamento)} ({formatarMoeda(Math.abs(resolvendoDuplicata.lancamento.valor))})
                  bate com {resolvendoDuplicata.candidatos.length === 1 ? "uma conta a pagar que já consta como paga" : "contas a pagar que já constam como pagas"}:
                </p>
                <div className="space-y-2 mb-4">
                  {resolvendoDuplicata.candidatos.map((c) => (
                    <div key={c.id} className="flex justify-between items-center px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs">
                      <span>
                        <span className="font-semibold">{c.fornecedor}</span>
                        <br />
                        <span className="text-[var(--color-text-muted)]">
                          {c.data_pagamento ? `Pago em ${formatarData(c.data_pagamento)}` : "Pago"}
                        </span>
                      </span>
                      <span className="font-semibold">{formatarMoeda(c.valor)}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-[var(--color-text-muted)] mb-3">
                  Se este pagamento já foi registrado quando a conta acima foi dada como paga, descarte este lançamento do extrato. Se não for o mesmo pagamento, feche e classifique normalmente.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={fecharDuplicata}
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                  >
                    Não é duplicata
                  </button>
                  <button
                    type="button"
                    onClick={handleDescartarDuplicata}
                    className="flex-1 px-3 py-2 rounded-lg bg-red-500 text-white text-xs font-semibold hover:bg-red-600"
                  >
                    Descartar
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {aba === "regras" && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <p className="text-xs text-[var(--color-text-muted)]">
              Regras ativas são testadas por ordem de prioridade (menor número primeiro); a primeira que casar classifica o lançamento.
            </p>
            {podeEscrever && (
              <button
                type="button"
                onClick={abrirNovaRegra}
                className="px-3 py-2 rounded-lg bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap ml-3"
              >
                + Nova regra
              </button>
            )}
          </div>

          {carregandoRegras ? (
            <div className="skeleton h-32 rounded-xl" />
          ) : regras.length === 0 ? (
            <EmptyState variant="categories" title="Nenhuma regra criada" description="Crie regras aqui ou classifique um lançamento manualmente e aceite a sugestão de regra." compact />
          ) : (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-3 py-2.5 font-semibold">Nome</th>
                    <th className="px-3 py-2.5 font-semibold">Padrão</th>
                    <th className="px-3 py-2.5 font-semibold">Categoria</th>
                    <th className="px-3 py-2.5 font-semibold text-center">Prioridade</th>
                    <th className="px-3 py-2.5 font-semibold text-center">Usos</th>
                    <th className="px-3 py-2.5 font-semibold text-center">Ativa</th>
                    <th className="px-3 py-2.5 font-semibold">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {regras.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                      <td className="px-3 py-2.5">{r.nome}</td>
                      <td className="px-3 py-2.5">
                        <code className="text-[10px] bg-[var(--hover-bg)] px-1.5 py-0.5 rounded">{r.tipo_match}</code> {r.padrao}
                      </td>
                      <td className="px-3 py-2.5">{r.categoria}</td>
                      <td className="px-3 py-2.5 text-center">{r.prioridade}</td>
                      <td className="px-3 py-2.5 text-center">{r.vezes_aplicada}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          type="button"
                          disabled={!podeEscrever}
                          onClick={() => handleAlternarAtiva(r)}
                          className={`px-2 py-1 rounded-full text-[10px] font-semibold ${
                            r.ativa ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                          } disabled:opacity-60`}
                        >
                          {r.ativa ? "Ativa" : "Inativa"}
                        </button>
                      </td>
                      <td className="px-3 py-2.5">
                        {podeEscrever && (
                          <div className="flex gap-2">
                            <button type="button" onClick={() => abrirEdicaoRegra(r)} className="text-blue-600 hover:underline text-[11px] font-medium">
                              editar
                            </button>
                            <button type="button" onClick={() => handleExcluirRegra(r)} className="text-red-500 hover:underline text-[11px] font-medium">
                              excluir
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {mostrarFormRegra && podeEscrever && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setMostrarFormRegra(false)}>
              <div className="bg-[var(--color-surface)] rounded-2xl p-5 max-w-md w-full space-y-3" onClick={(e) => e.stopPropagation()}>
                <h3 className="font-semibold text-sm">{editandoRegraId ? "Editar regra" : "Nova regra"}</h3>

                <div>
                  <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Nome</label>
                  <input
                    value={formRegra.nome}
                    onChange={(e) => setFormRegra((f) => ({ ...f, nome: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                  />
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Tipo de correspondência</label>
                    <select
                      value={formRegra.tipo_match}
                      onChange={(e) => setFormRegra((f) => ({ ...f, tipo_match: e.target.value as typeof f.tipo_match }))}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                    >
                      <option value="contem">Contém</option>
                      <option value="comeca_com">Começa com</option>
                      <option value="regex">Regex</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Prioridade</label>
                    <input
                      type="number"
                      value={formRegra.prioridade}
                      onChange={(e) => setFormRegra((f) => ({ ...f, prioridade: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Padrão</label>
                  <input
                    value={formRegra.padrao}
                    onChange={(e) => setFormRegra((f) => ({ ...f, padrao: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
                  <select
                    value={formRegra.categoria}
                    onChange={(e) => setFormRegra((f) => ({ ...f, categoria: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                  >
                    <option value="">Selecione...</option>
                    {formRegra.categoria &&
                      !categoriasEntrada.includes(formRegra.categoria) &&
                      !categoriasSaida.includes(formRegra.categoria) && (
                        <optgroup label="Atual (fora das categorias ativas)">
                          <option value={formRegra.categoria}>{formRegra.categoria}</option>
                        </optgroup>
                      )}
                    <optgroup label="Entrada">
                      {categoriasEntrada.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Saída">
                      {categoriasSaida.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Conta (opcional)</label>
                  <select
                    value={formRegra.conta_id}
                    onChange={(e) => setFormRegra((f) => ({ ...f, conta_id: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                  >
                    <option value="">Todas as contas</option>
                    {contas.map((c) => (
                      <option key={c.id} value={c.id}>
                        {nomeConta(c)}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Valor mínimo</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formRegra.valor_min}
                      onChange={(e) => setFormRegra((f) => ({ ...f, valor_min: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold mb-1 text-[var(--color-text-muted)]">Valor máximo</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formRegra.valor_max}
                      onChange={(e) => setFormRegra((f) => ({ ...f, valor_max: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm"
                    />
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={formRegra.ativa} onChange={(e) => setFormRegra((f) => ({ ...f, ativa: e.target.checked }))} />
                  Regra ativa
                </label>

                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setMostrarFormRegra(false)}
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={salvandoRegra}
                    onClick={handleSalvarRegra}
                    className="flex-1 px-3 py-2 rounded-lg bg-emerald-500 text-white text-xs font-semibold disabled:opacity-60"
                  >
                    {salvandoRegra ? "Salvando..." : "Salvar"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
