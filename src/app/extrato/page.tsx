"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseOfx, decodificarOfx, OfxParseError } from "@/lib/ofx";
import { parseRelatorioPix, RelatorioPixParseError } from "@/lib/relatorio-pix";
import { calcularCobertura, type CandidatoOfx, type LancamentoExistentePix } from "@/lib/cobertura-pix";
import { aplicarRegras, type RegraExtrato as RegraMotor, type LancamentoClassificavel } from "@/lib/regras-extrato";
import { calcularTipoMovimentacao, agruparResumoPorDia, type ResumoDia } from "@/lib/preview-movimentacao";
import EmptyState from "@/components/empty-state";
import { calcularBaixasAutomaticas, type CandidatoBaixa, type ContaPagarPendente } from "@/lib/baixa-contas-pagar";
import { registrarLog } from "@/lib/audit";

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
}

// Reaproveita exatamente a mesma escrita que a baixa manual já faz em
// src/app/(app)/contas-pagar/page.tsx (confirmarPagamento) -- nenhum caminho
// de escrita novo em contas_pagar/movimentacoes. Usada tanto pela baixa
// automática (candidato único) quanto pela resolução manual de ambíguos.
async function baixarContaPagar(
  lancamento: { id: string; data_lancamento: string },
  conta: { id: string; fornecedor: string; valor: number; categoria_id: string | null },
  categoriaNome: string
): Promise<boolean> {
  const supabase = createClient();
  // .select("id") depois do update deixa explícito quantas linhas o update
  // realmente afetou. .eq("status", "pendente") só bate se a conta ainda
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
  if (erroBaixa || !linhasAtualizadas || linhasAtualizadas.length === 0) return false;

  await supabase.from("movimentacoes").insert({
    tipo: "saida",
    data: lancamento.data_lancamento,
    valor: conta.valor,
    categoria_id: conta.categoria_id,
    observacao: `Pagamento: ${conta.fornecedor}`,
    revisar: false,
    conta_pagar_id: conta.id,
  });

  await supabase
    .from("extrato_lancamento")
    .update({
      status: "classificado",
      categoria: categoriaNome,
      classificado_em: new Date().toISOString(),
      conta_pagar_id: conta.id,
      contas_pagar_candidatas: null,
    })
    .eq("id", lancamento.id);

  await registrarLog({ acao: "pagou", tabela: "contas_pagar", registroId: conta.id, detalhes: `${conta.fornecedor} - baixa automática via extrato` });
  return true;
}

// Roda sobre lançamentos de saída recém-chegados (import de OFX ou
// reprocessamento). Nunca decide um empate sozinho -- ver calcularBaixasAutomaticas.
async function processarBaixasAutomaticas(
  lancamentosNovos: LancamentoParaBaixa[]
): Promise<{ baixados: number; ambiguos: number; idsBaixados: Set<string>; idsAmbiguos: Set<string> }> {
  const supabase = createClient();
  const idsBaixados = new Set<string>();
  const idsAmbiguos = new Set<string>();
  const saidas = lancamentosNovos.filter((l) => l.valor < 0 && l.status === "nao_classificado");
  if (saidas.length === 0) return { baixados: 0, ambiguos: 0, idsBaixados, idsAmbiguos };

  // .limit(2000) por precaução -- mesma classe de problema já corrigida antes
  // neste projeto (commit 693a921): PostgREST tem teto padrão de linhas.
  // contas_pagar pendentes reais nunca chegaram perto disso, mas não custa nada.
  const { data: pendentes } = await supabase
    .from("contas_pagar")
    .select("id, fornecedor, valor, categoria_id")
    .eq("status", "pendente")
    .limit(2000);
  if (!pendentes || pendentes.length === 0) return { baixados: 0, ambiguos: 0, idsBaixados, idsAmbiguos };

  const { data: categoriasSaidaTodas } = await supabase.from("categorias_saida").select("id, nome");
  const nomeCategoriaPorId = new Map((categoriasSaidaTodas ?? []).map((c) => [c.id as string, c.nome as string]));

  const candidatos: CandidatoBaixa[] = saidas.map((l, indice) => ({
    indice,
    valor: Math.abs(Number(l.valor)),
    descricaoNormalizada: l.descricao_normalizada,
  }));
  const contasPendentes: ContaPagarPendente[] = pendentes.map((c) => ({
    id: c.id as string,
    fornecedor: c.fornecedor as string,
    valor: Number(c.valor),
  }));

  const resultado = calcularBaixasAutomaticas(candidatos, contasPendentes);
  const pendentesPorId = new Map(pendentes.map((c) => [c.id as string, c]));

  let baixados = 0;
  for (const b of resultado.baixados) {
    const lancamento = saidas[b.indice];
    const conta = pendentesPorId.get(b.contaPagarId);
    if (!conta) continue;
    const categoriaId = conta.categoria_id as string | null;
    const categoriaNome = categoriaId ? nomeCategoriaPorId.get(categoriaId) ?? "Contas a pagar" : "Contas a pagar";
    const ok = await baixarContaPagar(
      { id: lancamento.id, data_lancamento: lancamento.data_lancamento },
      { id: conta.id as string, fornecedor: conta.fornecedor as string, valor: Number(conta.valor), categoria_id: categoriaId },
      categoriaNome
    );
    if (ok) {
      idsBaixados.add(lancamento.id);
      baixados++;
    }
  }

  let ambiguos = 0;
  for (const a of resultado.ambiguos) {
    const lancamento = saidas[a.indice];
    await supabase.from("extrato_lancamento").update({ contas_pagar_candidatas: a.candidatosIds }).eq("id", lancamento.id);
    idsAmbiguos.add(lancamento.id);
    ambiguos++;
  }

  return { baixados, ambiguos, idsBaixados, idsAmbiguos };
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
  const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; cobertos: number; baixados: number; ambiguos: number; avisos: string[] } | null>(null);
  const [mostrarNovaConta, setMostrarNovaConta] = useState(false);
  const [novaContaBanco, setNovaContaBanco] = useState("santander");
  const [novaContaApelido, setNovaContaApelido] = useState("");
  const [novaContaAgencia, setNovaContaAgencia] = useState("");
  const [novaContaNumero, setNovaContaNumero] = useState("");
  const [criandoConta, setCriandoConta] = useState(false);
  const inputArquivoRef = useRef<HTMLInputElement>(null);
  const [arquivoPix, setArquivoPix] = useState<File | null>(null);
  const [importandoPix, setImportandoPix] = useState(false);
  const [resumoImportacaoPix, setResumoImportacaoPix] = useState<{ lidas: number; novas: number; duplicadas: number; avisos: string[] } | null>(null);
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
    let autoQ = supabase
      .from("extrato_lancamento")
      .select("*", { count: "exact", head: true })
      .eq("status", "classificado")
      .not("regra_id", "is", null);

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

  async function classificarPorRegras(candidatos: LancamentoClassificavel[]): Promise<number> {
    if (candidatos.length === 0) return 0;
    const { data: regrasAtivas, error } = await supabase.from("extrato_regra").select("*").eq("ativa", true);
    if (error || !regrasAtivas || regrasAtivas.length === 0) return 0;

    const resultados = aplicarRegras(candidatos, regrasAtivas as RegraMotor[]);
    if (resultados.length === 0) return 0;

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

    return resultados.length;
  }

  async function handleReprocessar() {
    if (!podeEscrever) return;
    setMensagem(null);
    setReprocessando(true);
    try {
      let query = supabase
        .from("extrato_lancamento")
        .select("id, conta_id, descricao_normalizada, valor, status, data_lancamento")
        .eq("status", "nao_classificado");
      if (filtroContaId) query = query.eq("conta_id", filtroContaId);
      const { data: candidatos, error } = await query;
      if (error) throw new Error(error.message);

      const candidatosTipados = (candidatos ?? []) as LancamentoParaBaixa[];
      const baixasAuto = await processarBaixasAutomaticas(candidatosTipados);
      const paraClassificar = candidatosTipados.filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
      const qtd = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);

      const partes: string[] = [];
      if (baixasAuto.baixados > 0) partes.push(`${baixasAuto.baixados} baixado(s) automaticamente`);
      if (baixasAuto.ambiguos > 0) partes.push(`${baixasAuto.ambiguos} ambíguo(s) (revisar)`);
      if (qtd > 0) partes.push(`${qtd} classificado(s) por regra`);

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

      let baixasAuto = { baixados: 0, ambiguos: 0, idsBaixados: new Set<string>(), idsAmbiguos: new Set<string>() };
      if (inseridos && inseridos.length > 0) {
        baixasAuto = await processarBaixasAutomaticas(inseridos as LancamentoParaBaixa[]);
      }

      let classificadosAuto = 0;
      if (inseridos && inseridos.length > 0) {
        const paraClassificar = (inseridos as LancamentoParaBaixa[]).filter((l) => !baixasAuto.idsBaixados.has(l.id) && !baixasAuto.idsAmbiguos.has(l.id));
        if (paraClassificar.length > 0) {
          classificadosAuto = await classificarPorRegras(paraClassificar as LancamentoClassificavel[]);
        }
      }

      setResumoImportacao({ lidas: parsed.transacoes.length, novas, duplicadas, cobertos, baixados: baixasAuto.baixados, ambiguos: baixasAuto.ambiguos, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${parsed.transacoes.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (cobertos > 0 ? ` · ${cobertos} já cobertas pelo relatório Pix` : "") +
          (baixasAuto.baixados > 0 ? ` · ${baixasAuto.baixados} baixado(s) automaticamente` : "") +
          (baixasAuto.ambiguos > 0 ? ` · ${baixasAuto.ambiguos} ambígua(s) (revisar)` : "") +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
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
        .select("id, conta_id, descricao_normalizada, valor, status");

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
      if (inseridos && inseridos.length > 0) {
        classificadosAuto = await classificarPorRegras(inseridos as LancamentoClassificavel[]);
      }

      setResumoImportacaoPix({ lidas: linhas.length, novas, duplicadas, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${linhas.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
          (classificadosAuto > 0 ? ` · ${classificadosAuto} classificada(s) automaticamente` : ""),
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
    const { error } = await supabase
      .from("extrato_lancamento")
      .update({
        categoria: categoria.trim(),
        status: "classificado",
        classificado_em: new Date().toISOString(),
        classificado_por: user?.id ?? null,
        regra_id: null,
      })
      .eq("id", lancamento.id);
    setAcaoLancamentoId(null);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao classificar: " + error.message });
      return;
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

  async function handleIgnorar(lancamento: Lancamento) {
    setAcaoLancamentoId(lancamento.id);
    setMensagem(null);
    const { error } = await supabase.from("extrato_lancamento").update({ status: "ignorado" }).eq("id", lancamento.id);
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
          Fase 1 do projeto de conciliação — camada de staging, isolada do sistema principal. Nada aqui é gravado em Movimentações ou Contas a Pagar.
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
                                      </div>
                                    ) : l.status === "ignorado" ? (
                                      <span className="text-[10px] text-[var(--color-text-muted)]">—</span>
                                    ) : (
                                      <span className="text-[10px] text-amber-600 font-medium">pendente</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 whitespace-nowrap text-[10px] text-[var(--color-text-muted)]">
                                    {l.status === "ignorado" ? "ignorado" : l.regra_id ? "regra" : l.categoria ? "manual" : "—"}
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
