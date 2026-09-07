"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import EmptyState from "@/components/empty-state";
import { useRole } from "@/lib/role-context";
import { registrarLog } from "@/lib/audit";
import {
  parseCartaoVendasDetalhado,
  parseCartaoVendasConsolidado,
  detectarTipoArquivo,
  CartaoVendasParseError,
  type ParseDetalhadoResult,
  type ParseConsolidadoResult,
  type ModalidadeCartao,
  type StatusTransacaoCartao,
} from "@/lib/cartao-vendas-parser";
import {
  agruparRecebiveis,
  conciliarBuckets,
  compararSomas,
  auditarTaxas,
  type ComparacaoSoma,
  type CandidatoExtrato,
  type StatusConciliacao,
  type TransacaoParaProvisao,
  type AuditoriaTaxa,
} from "@/lib/conciliacao-cartao";
import { calcularDataPrevista } from "@/lib/dias-uteis-cartao";

// Teto de linhas por consulta -- mesmo problema/solução do /extrato (limite
// padrão do PostgREST): ver LIMITE_LANCAMENTOS em extrato/page.tsx.
const LIMITE_LINHAS = 5000;
const TAMANHO_LOTE_UPSERT = 500;

type Mensagem = { tipo: "sucesso" | "erro"; texto: string } | null;

interface TransacaoDb {
  id: string;
  importacao_id: string;
  origem_planilha: "cartoes" | "pix" | "voucher";
  bandeira: string;
  modalidade: ModalidadeCartao;
  forma_pagamento: string | null;
  data_hora_venda: string;
  status_transacao: StatusTransacaoCartao;
  parcelas: number;
  numero_cartao_mascarado: string | null;
  numero_autorizacao: string | null;
  numero_comprovante: string | null;
  numero_terminal: string | null;
  valor_bruto: number;
  valor_taxa: number | null;
  valor_liquido: number | null;
  data_prevista_pagamento: string | null;
  data_prevista_calculada: string | null;
}

interface ImportacaoDb {
  id: string;
  tipo_arquivo: "detalhado" | "consolidado";
  nome_arquivo: string;
  periodo_inicio: string | null;
  periodo_fim: string | null;
  total_linhas_lidas: number;
  total_linhas_importadas: number;
  total_avisos: number;
  importado_em: string;
}

interface TaxaContratadaDb {
  id: string;
  bandeira: string;
  modalidade: ModalidadeCartao;
  taxa_percentual: number | null;
  prazo_dias: number | null;
  prazo_tipo: "uteis" | "corridos" | null;
  ativo: boolean;
  observacao: string | null;
}

interface ConciliacaoDb {
  id: string;
  data_prevista: string;
  bandeira: string;
  modalidade: string;
  valor_previsto: number;
  extrato_lancamento_id: string | null;
  valor_recebido: number | null;
  diferenca: number | null;
  status: StatusConciliacao | "aguardando";
  candidatos_ids: string[] | null;
  observacao: string | null;
}

interface LancamentoInfo {
  id: string;
  data_lancamento: string;
  valor: number;
  descricao: string;
}

function formatarMoeda(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarData(iso: string | null) {
  if (!iso) return "—";
  const [ano, mes, dia] = iso.slice(0, 10).split("-");
  return `${dia}/${mes}/${ano}`;
}

function formatarDataHora(iso: string) {
  const data = new Date(iso);
  return data.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const LABEL_MODALIDADE: Record<string, string> = { credito: "Crédito", debito: "Débito", pix: "Pix", voucher: "Voucher" };
const LABEL_ORIGEM: Record<string, string> = { cartoes: "Cartão", pix: "Pix", voucher: "Voucher" };

function badgeStatusTransacao(status: StatusTransacaoCartao) {
  const mapa: Record<StatusTransacaoCartao, { label: string; classe: string }> = {
    aprovada: { label: "Aprovada", classe: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    paga: { label: "Paga", classe: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    negada: { label: "Negada", classe: "bg-gray-100 text-gray-600 border-gray-200" },
    estornada: { label: "Estornada", classe: "bg-red-50 text-red-700 border-red-200" },
    expirada: { label: "QR expirado", classe: "bg-gray-100 text-gray-500 border-gray-200" },
  };
  return mapa[status];
}

function badgeStatusConciliacao(status: ConciliacaoDb["status"]) {
  const mapa: Record<string, { label: string; classe: string }> = {
    conciliado: { label: "✓ Conciliado", classe: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    conciliado_manual: { label: "✓ Conciliado (manual)", classe: "bg-emerald-50 text-emerald-700 border-emerald-200" },
    divergente: { label: "⚠ Divergente", classe: "bg-amber-50 text-amber-700 border-amber-200" },
    sem_deposito_encontrado: { label: "🚨 Sem depósito", classe: "bg-red-50 text-red-700 border-red-200" },
    multiplos_candidatos: { label: "◐ Escolher manualmente", classe: "bg-slate-100 text-slate-700 border-slate-300" },
    aguardando: { label: "Aguardando", classe: "bg-gray-100 text-gray-600 border-gray-200" },
  };
  return mapa[status] ?? mapa.aguardando;
}

export default function ConciliacaoCartaoPage() {
  const supabase = createClient();
  const { isReadOnly } = useRole();

  const [aba, setAba] = useState<"importar" | "transacoes" | "conciliacao" | "taxas">("importar");
  const [mensagem, setMensagem] = useState<Mensagem>(null);

  function avisar(m: Mensagem, duracaoMs = 6000) {
    setMensagem(m);
    if (m) setTimeout(() => setMensagem(null), duracaoMs);
  }

  // ---------------------------------------------------------------------
  // Importar
  // ---------------------------------------------------------------------
  const [arquivoDetalhado, setArquivoDetalhado] = useState<File | null>(null);
  const [arquivoConsolidado, setArquivoConsolidado] = useState<File | null>(null);
  const inputDetalhadoRef = useRef<HTMLInputElement>(null);
  const inputConsolidadoRef = useRef<HTMLInputElement>(null);
  const [analisando, setAnalisando] = useState(false);
  const [importando, setImportando] = useState(false);
  const [previewDetalhado, setPreviewDetalhado] = useState<ParseDetalhadoResult | null>(null);
  const [previewConsolidado, setPreviewConsolidado] = useState<ParseConsolidadoResult | null>(null);
  const [comparacaoSomas, setComparacaoSomas] = useState<ComparacaoSoma[] | null>(null);
  const [importacoes, setImportacoes] = useState<ImportacaoDb[]>([]);

  async function carregarImportacoes() {
    const { data } = await supabase.from("cartao_importacao").select("*").order("importado_em", { ascending: false }).limit(50);
    if (data) setImportacoes(data as ImportacaoDb[]);
  }

  async function handleAnalisar() {
    avisar(null);
    if (!arquivoDetalhado) {
      avisar({ tipo: "erro", texto: "Selecione o arquivo Detalhado (obrigatório) exportado da maquininha." });
      return;
    }
    setAnalisando(true);
    setPreviewDetalhado(null);
    setPreviewConsolidado(null);
    setComparacaoSomas(null);
    try {
      const bytesDetalhado = new Uint8Array(await arquivoDetalhado.arrayBuffer());
      const tipoDetectado = await detectarTipoArquivo(bytesDetalhado, arquivoDetalhado.name);
      if (tipoDetectado !== "detalhado") {
        throw new CartaoVendasParseError(
          `"${arquivoDetalhado.name}" parece ser o relatório Consolidado, não o Detalhado. Confira os arquivos selecionados.`
        );
      }
      const resultado = await parseCartaoVendasDetalhado(bytesDetalhado, arquivoDetalhado.name);
      setPreviewDetalhado(resultado);

      if (arquivoConsolidado) {
        const bytesConsolidado = new Uint8Array(await arquivoConsolidado.arrayBuffer());
        const tipoConsolidado = await detectarTipoArquivo(bytesConsolidado, arquivoConsolidado.name);
        if (tipoConsolidado !== "consolidado") {
          throw new CartaoVendasParseError(`"${arquivoConsolidado.name}" parece ser o relatório Detalhado, não o Consolidado.`);
        }
        const resultadoConsolidado = await parseCartaoVendasConsolidado(bytesConsolidado, arquivoConsolidado.name);
        setPreviewConsolidado(resultadoConsolidado);
        setComparacaoSomas(compararSomas(resultado.transacoes, resultadoConsolidado.totais));
      }
    } catch (e) {
      avisar({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao ler o arquivo." });
      setPreviewDetalhado(null);
      setPreviewConsolidado(null);
      setComparacaoSomas(null);
    } finally {
      setAnalisando(false);
    }
  }

  async function handleConfirmarImportacao() {
    if (!previewDetalhado || !arquivoDetalhado) return;
    setImportando(true);
    avisar(null);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const { data: feriadosRaw } = await supabase.from("feriados").select("data");
      const feriadosSet = new Set((feriadosRaw ?? []).map((f) => f.data as string));

      const { data: importacaoCriada, error: erroImportacao } = await supabase
        .from("cartao_importacao")
        .insert({
          tipo_arquivo: "detalhado",
          nome_arquivo: arquivoDetalhado.name,
          periodo_inicio: previewDetalhado.periodoInicio,
          periodo_fim: previewDetalhado.periodoFim,
          total_linhas_lidas: previewDetalhado.totalLinhasLidas,
          total_linhas_importadas: previewDetalhado.transacoes.length,
          total_avisos: previewDetalhado.avisos.length,
          avisos: previewDetalhado.avisos,
          importado_por: user?.id ?? null,
        })
        .select("id")
        .single();
      if (erroImportacao) throw new Error(erroImportacao.message);
      const importacaoId = importacaoCriada.id as string;

      // Sanity-check: nosso próprio cálculo de dia útil contra a data que a
      // adquirente já manda no arquivo (crédito/débito) -- nunca substitui a
      // data da adquirente (é ela que decide o depósito de verdade), só sinaliza
      // divergência pra revisão manual.
      let divergenciasDiaUtil = 0;
      const linhas = previewDetalhado.transacoes.map((t) => {
        const dataVenda = t.dataHoraVenda.slice(0, 10);
        // Só calcula pra transação aprovada -- negada/estornada nunca teve
        // (nem terá) uma data de recebimento de verdade pra comparar, então
        // o campo da adquirente vem null e não é uma "divergência" nossa.
        const dataCalculada =
          t.modalidade === "voucher" || t.statusTransacao !== "aprovada" ? null : calcularDataPrevista(dataVenda, t.modalidade, feriadosSet);
        if (dataCalculada && t.dataPrevistaPagamento && dataCalculada !== t.dataPrevistaPagamento) divergenciasDiaUtil++;
        return {
          importacao_id: importacaoId,
          origem_planilha: t.origemPlanilha,
          bandeira: t.bandeira,
          modalidade: t.modalidade,
          forma_pagamento: t.formaPagamento,
          data_hora_venda: t.dataHoraVenda,
          status_transacao: t.statusTransacao,
          parcelas: t.parcelas,
          numero_cartao_mascarado: t.numeroCartaoMascarado,
          numero_autorizacao: t.numeroAutorizacao,
          numero_comprovante: t.numeroComprovante,
          numero_terminal: t.numeroTerminal,
          valor_bruto: t.valorBruto,
          valor_taxa: t.valorTaxa,
          valor_liquido: t.valorLiquido,
          data_prevista_pagamento: t.dataPrevistaPagamento,
          data_prevista_calculada: dataCalculada,
          dados_brutos: t.dadosBrutos,
        };
      });

      let totalInseridas = 0;
      for (let i = 0; i < linhas.length; i += TAMANHO_LOTE_UPSERT) {
        const lote = linhas.slice(i, i + TAMANHO_LOTE_UPSERT);
        const { data: inseridos, error } = await supabase
          .from("cartao_transacao")
          .upsert(lote, { onConflict: "numero_comprovante,numero_terminal,data_hora_venda", ignoreDuplicates: true })
          .select("id");
        if (error) throw new Error(error.message);
        totalInseridas += inseridos?.length ?? 0;
      }

      if (arquivoConsolidado && previewConsolidado) {
        await supabase.from("cartao_importacao").insert({
          tipo_arquivo: "consolidado",
          nome_arquivo: arquivoConsolidado.name,
          periodo_inicio: previewConsolidado.periodoInicio,
          periodo_fim: previewConsolidado.periodoFim,
          total_linhas_lidas: previewConsolidado.totais.length,
          total_linhas_importadas: 0,
          total_avisos: previewConsolidado.avisos.length,
          avisos: previewConsolidado.avisos,
          importado_por: user?.id ?? null,
        });
      }

      await registrarLog({
        acao: "importou",
        tabela: "cartao_transacao",
        registroId: importacaoId,
        detalhes:
          `Conciliação de cartão: ${arquivoDetalhado.name}` +
          (arquivoConsolidado ? ` + ${arquivoConsolidado.name}` : "") +
          ` — ${totalInseridas} nova(s) de ${linhas.length} lida(s).`,
      });

      const somasBatem = comparacaoSomas ? comparacaoSomas.every((c) => c.ok) : null;
      avisar(
        {
          tipo: somasBatem === false ? "erro" : "sucesso",
          texto:
            `${linhas.length} transação(ões) lida(s) · ${totalInseridas} nova(s) · ${linhas.length - totalInseridas} já existente(s)` +
            (previewDetalhado.avisos.length > 0 ? ` · ${previewDetalhado.avisos.length} aviso(s) de leitura` : "") +
            (divergenciasDiaUtil > 0 ? ` · ${divergenciasDiaUtil} com data prevista diferente do nosso cálculo (revisar)` : "") +
            (comparacaoSomas
              ? somasBatem
                ? " · ✓ soma bate com o relatório Consolidado"
                : " · 🚨 SOMA NÃO BATE com o relatório Consolidado — veja o comparativo abaixo antes de confiar neste lote"
              : ""),
        },
        10000
      );

      setArquivoDetalhado(null);
      setArquivoConsolidado(null);
      if (inputDetalhadoRef.current) inputDetalhadoRef.current.value = "";
      if (inputConsolidadoRef.current) inputConsolidadoRef.current.value = "";
      setPreviewDetalhado(null);
      setPreviewConsolidado(null);
      setComparacaoSomas(null);
      carregarImportacoes();
    } catch (e) {
      avisar({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao importar." });
    } finally {
      setImportando(false);
    }
  }

  // ---------------------------------------------------------------------
  // Transações
  // ---------------------------------------------------------------------
  const [transacoes, setTransacoes] = useState<TransacaoDb[]>([]);
  const [carregandoTransacoes, setCarregandoTransacoes] = useState(false);
  const [filtroOrigem, setFiltroOrigem] = useState<"todas" | "cartoes" | "voucher">("todas");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | StatusTransacaoCartao>("todos");
  const [filtroBandeira, setFiltroBandeira] = useState("");
  const [filtroDataInicio, setFiltroDataInicio] = useState("");
  const [filtroDataFim, setFiltroDataFim] = useState("");

  async function carregarTransacoes() {
    setCarregandoTransacoes(true);
    let query = supabase
      .from("cartao_transacao")
      .select(
        "id, importacao_id, origem_planilha, bandeira, modalidade, forma_pagamento, data_hora_venda, status_transacao, parcelas, numero_cartao_mascarado, numero_autorizacao, numero_comprovante, numero_terminal, valor_bruto, valor_taxa, valor_liquido, data_prevista_pagamento, data_prevista_calculada"
      )
      .order("data_hora_venda", { ascending: false })
      .limit(LIMITE_LINHAS);
    if (filtroOrigem !== "todas") query = query.eq("origem_planilha", filtroOrigem);
    if (filtroStatus !== "todos") query = query.eq("status_transacao", filtroStatus);
    if (filtroBandeira.trim()) query = query.ilike("bandeira", `%${filtroBandeira.trim()}%`);
    if (filtroDataInicio) query = query.gte("data_hora_venda", filtroDataInicio);
    if (filtroDataFim) query = query.lte("data_hora_venda", filtroDataFim + "T23:59:59");

    const { data, error } = await query;
    if (!error && data) setTransacoes(data as TransacaoDb[]);
    setCarregandoTransacoes(false);
  }

  useEffect(() => {
    if (aba === "transacoes") carregarTransacoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba, filtroOrigem, filtroStatus, filtroBandeira, filtroDataInicio, filtroDataFim]);

  // ---------------------------------------------------------------------
  // Conciliação (Provisão x Recebido)
  // ---------------------------------------------------------------------
  const [conciliacoes, setConciliacoes] = useState<ConciliacaoDb[]>([]);
  const [carregandoConciliacoes, setCarregandoConciliacoes] = useState(false);
  const [recalculando, setRecalculando] = useState(false);
  const [lancamentosInfo, setLancamentosInfo] = useState<Map<string, LancamentoInfo>>(new Map());
  const [filtroStatusConciliacao, setFiltroStatusConciliacao] = useState<"todos" | ConciliacaoDb["status"]>("todos");

  async function carregarConciliacoes() {
    setCarregandoConciliacoes(true);
    const { data, error } = await supabase
      .from("cartao_conciliacao")
      .select("*")
      .order("data_prevista", { ascending: false })
      .limit(LIMITE_LINHAS);
    if (!error && data) {
      const linhas = data as ConciliacaoDb[];
      setConciliacoes(linhas);

      const idsParaBuscar = new Set<string>();
      for (const l of linhas) {
        if (l.extrato_lancamento_id) idsParaBuscar.add(l.extrato_lancamento_id);
        for (const c of l.candidatos_ids ?? []) idsParaBuscar.add(c);
      }
      if (idsParaBuscar.size > 0) {
        const { data: lancamentos } = await supabase
          .from("extrato_lancamento")
          .select("id, data_lancamento, valor, descricao")
          .in("id", [...idsParaBuscar]);
        const mapa = new Map<string, LancamentoInfo>();
        for (const l of lancamentos ?? []) mapa.set(l.id as string, l as LancamentoInfo);
        setLancamentosInfo(mapa);
      } else {
        setLancamentosInfo(new Map());
      }
    }
    setCarregandoConciliacoes(false);
  }

  useEffect(() => {
    if (aba === "conciliacao") carregarConciliacoes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba]);

  async function handleRecalcularConciliacao() {
    setRecalculando(true);
    avisar(null);
    try {
      const { data: transacoesProvisao, error: erroTransacoes } = await supabase
        .from("cartao_transacao")
        .select("bandeira, modalidade, status_transacao, valor_liquido, data_prevista_pagamento")
        .in("status_transacao", ["aprovada", "paga"])
        .not("data_prevista_pagamento", "is", null)
        .limit(LIMITE_LINHAS);
      if (erroTransacoes) throw new Error(erroTransacoes.message);

      const transacoesParaProvisao: TransacaoParaProvisao[] = (transacoesProvisao ?? []).map((t) => ({
        bandeira: t.bandeira as string,
        modalidade: t.modalidade as ModalidadeCartao,
        statusTransacao: t.status_transacao as StatusTransacaoCartao,
        valorLiquido: t.valor_liquido as number | null,
        dataPrevistaPagamento: t.data_prevista_pagamento as string | null,
      }));
      const { buckets, semDataPrevista } = agruparRecebiveis(transacoesParaProvisao);

      if (buckets.length === 0) {
        avisar({ tipo: "erro", texto: "Nenhuma transação provisionável encontrada (importe o arquivo Detalhado primeiro)." });
        return;
      }

      const datas = buckets.map((b) => b.dataPrevista);
      const dataMinima = datas.reduce((min, d) => (d < min ? d : min));
      const dataMaxima = datas.reduce((max, d) => (d > max ? d : max));
      const janelaInicio = new Date(new Date(dataMinima + "T00:00:00Z").getTime() - 2 * 86400000).toISOString().slice(0, 10);
      const janelaFim = new Date(new Date(dataMaxima + "T00:00:00Z").getTime() + 4 * 86400000).toISOString().slice(0, 10);

      const { data: candidatosRaw, error: erroCandidatos } = await supabase
        .from("extrato_lancamento")
        .select("id, data_lancamento, valor")
        .gt("valor", 0)
        .gte("data_lancamento", janelaInicio)
        .lte("data_lancamento", janelaFim)
        .limit(LIMITE_LINHAS);
      if (erroCandidatos) throw new Error(erroCandidatos.message);

      const candidatos: CandidatoExtrato[] = (candidatosRaw ?? []).map((c) => ({
        id: c.id as string,
        data: c.data_lancamento as string,
        valor: c.valor as number,
      }));

      // Nunca sobrescreve uma escolha manual já feita (handleEscolherManual)
      // com o recálculo automático -- só recalcula de novo um bucket
      // 'conciliado_manual' se o valor previsto dele mudou (ex.: chegou mais
      // transação naquele dia/bandeira depois da escolha manual), porque aí
      // a escolha antiga não corresponde mais ao valor real provisionado e
      // precisa ser revista. Sem isso, todo "Recalcular" apagaria a decisão
      // humana e devolveria o bucket pro limbo de "escolher de novo".
      const { data: existentesRaw } = await supabase
        .from("cartao_conciliacao")
        .select("data_prevista, bandeira, modalidade, status, valor_previsto, extrato_lancamento_id")
        .eq("status", "conciliado_manual")
        .limit(LIMITE_LINHAS);
      const manualPreservado = new Map(
        (existentesRaw ?? []).map((e) => [`${e.data_prevista}|${e.bandeira}|${e.modalidade}`, e.valor_previsto as number])
      );
      // Lançamentos já reivindicados por uma escolha manual não podem ser
      // oferecidos a outro bucket neste recálculo -- mesma razão de
      // conciliarBuckets consumir o pool conforme casa: sem isso, o mesmo
      // depósito real apareceria como match "automático" de um segundo
      // bucket mesmo já estando comprometido com a escolha manual do primeiro.
      const idsJaReivindicadosManualmente = new Set(
        (existentesRaw ?? []).map((e) => e.extrato_lancamento_id).filter((id): id is string => !!id)
      );
      const candidatosDisponiveis = candidatos.filter((c) => !idsJaReivindicadosManualmente.has(c.id));

      const hoje = new Date().toISOString().slice(0, 10);
      const resultados = conciliarBuckets(buckets, candidatosDisponiveis, hoje);
      let preservados = 0;
      const linhas = resultados
        .filter((r) => {
          const valorManual = manualPreservado.get(`${r.dataPrevista}|${r.bandeira}|${r.modalidade}`);
          const mantemEscolhaManual = valorManual !== undefined && Math.abs(valorManual - r.valorPrevisto) < 0.01;
          if (mantemEscolhaManual) preservados++;
          return !mantemEscolhaManual;
        })
        .map((r) => ({
          data_prevista: r.dataPrevista,
          bandeira: r.bandeira,
          modalidade: r.modalidade,
          valor_previsto: r.valorPrevisto,
          extrato_lancamento_id: r.extratoLancamentoId,
          valor_recebido: r.valorRecebido,
          diferenca: r.diferenca,
          status: r.status,
          candidatos_ids: r.status === "multiplos_candidatos" ? r.candidatosIds : null,
        }));

      const TAMANHO_LOTE = 500;
      for (let i = 0; i < linhas.length; i += TAMANHO_LOTE) {
        const lote = linhas.slice(i, i + TAMANHO_LOTE);
        const { error } = await supabase.from("cartao_conciliacao").upsert(lote, { onConflict: "data_prevista,bandeira,modalidade" });
        if (error) throw new Error(error.message);
      }

      const contagem = { conciliado: 0, divergente: 0, sem_deposito_encontrado: 0, multiplos_candidatos: 0, aguardando: 0 };
      for (const r of resultados) contagem[r.status]++;
      avisar(
        {
          tipo: contagem.sem_deposito_encontrado > 0 ? "erro" : "sucesso",
          texto:
            `${buckets.length} bucket(s) recalculado(s) · ${contagem.conciliado} conciliado(s) · ${contagem.divergente} divergente(s) · ` +
            `${contagem.sem_deposito_encontrado} sem depósito encontrado · ${contagem.multiplos_candidatos} precisam de escolha manual · ` +
            `${contagem.aguardando} ainda não venceram` +
            (preservados > 0 ? ` · ${preservados} escolha(s) manual(is) preservada(s)` : "") +
            (semDataPrevista.length > 0 ? ` · ${semDataPrevista.length} transação(ões) aguardando taxa cadastrada (Voucher)` : ""),
        },
        10000
      );
      carregarConciliacoes();
    } catch (e) {
      avisar({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao recalcular." });
    } finally {
      setRecalculando(false);
    }
  }

  async function handleEscolherManual(conciliacaoId: string, extratoLancamentoId: string) {
    const info = lancamentosInfo.get(extratoLancamentoId);
    const conciliacao = conciliacoes.find((c) => c.id === conciliacaoId);
    if (!info || !conciliacao) return;
    const { error } = await supabase
      .from("cartao_conciliacao")
      .update({
        extrato_lancamento_id: extratoLancamentoId,
        valor_recebido: info.valor,
        diferenca: Math.round((info.valor - conciliacao.valor_previsto) * 100) / 100,
        status: "conciliado_manual",
        calculado_em: new Date().toISOString(),
      })
      .eq("id", conciliacaoId);
    if (error) avisar({ tipo: "erro", texto: error.message });
    else carregarConciliacoes();
  }

  const conciliacoesFiltradas = conciliacoes.filter((c) => filtroStatusConciliacao === "todos" || c.status === filtroStatusConciliacao);
  const totalPrevisto = conciliacoesFiltradas.reduce((s, c) => s + c.valor_previsto, 0);
  const totalRecebido = conciliacoesFiltradas.reduce((s, c) => s + (c.valor_recebido ?? 0), 0);
  const totalSemDeposito = conciliacoesFiltradas.filter((c) => c.status === "sem_deposito_encontrado").reduce((s, c) => s + c.valor_previsto, 0);

  // ---------------------------------------------------------------------
  // Taxas contratadas
  // ---------------------------------------------------------------------
  const [taxas, setTaxas] = useState<TaxaContratadaDb[]>([]);
  const [carregandoTaxas, setCarregandoTaxas] = useState(false);
  const [showFormTaxa, setShowFormTaxa] = useState(false);
  const [taxaEditandoId, setTaxaEditandoId] = useState<string | null>(null);
  const [formBandeira, setFormBandeira] = useState("");
  const [formModalidade, setFormModalidade] = useState<ModalidadeCartao>("voucher");
  const [formTaxaPercentual, setFormTaxaPercentual] = useState("");
  const [formPrazoDias, setFormPrazoDias] = useState("");
  const [formPrazoTipo, setFormPrazoTipo] = useState<"uteis" | "corridos">("corridos");
  const [formObservacao, setFormObservacao] = useState("");
  const [aplicandoRetroativo, setAplicandoRetroativo] = useState<string | null>(null);

  const [auditoria, setAuditoria] = useState<AuditoriaTaxa[]>([]);
  const [carregandoAuditoria, setCarregandoAuditoria] = useState(false);

  async function carregarTaxas() {
    setCarregandoTaxas(true);
    const { data } = await supabase.from("cartao_taxa_contratada").select("*").order("bandeira").order("modalidade");
    if (data) setTaxas(data as TaxaContratadaDb[]);
    setCarregandoTaxas(false);
  }

  async function carregarAuditoria(taxasAtuais: TaxaContratadaDb[]) {
    const contratadasComTaxa = taxasAtuais.filter((t) => t.ativo && t.taxa_percentual !== null);
    if (contratadasComTaxa.length === 0) {
      setAuditoria([]);
      return;
    }
    setCarregandoAuditoria(true);
    const { data } = await supabase
      .from("cartao_transacao")
      .select("bandeira, modalidade, valor_bruto, valor_taxa")
      .in("status_transacao", ["aprovada", "paga"])
      .limit(LIMITE_LINHAS);
    if (data) {
      setAuditoria(
        auditarTaxas(
          data.map((t) => ({ bandeira: t.bandeira as string, modalidade: t.modalidade as ModalidadeCartao, valorBruto: t.valor_bruto as number, valorTaxa: t.valor_taxa as number | null })),
          contratadasComTaxa.map((t) => ({ bandeira: t.bandeira, modalidade: t.modalidade, taxaPercentual: t.taxa_percentual }))
        )
      );
    }
    setCarregandoAuditoria(false);
  }

  useEffect(() => {
    if (aba === "taxas") carregarTaxas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba]);

  useEffect(() => {
    if (aba === "taxas" && taxas.length > 0) carregarAuditoria(taxas);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aba, taxas]);

  function limparFormTaxa() {
    setTaxaEditandoId(null);
    setFormBandeira("");
    setFormModalidade("voucher");
    setFormTaxaPercentual("");
    setFormPrazoDias("");
    setFormPrazoTipo("corridos");
    setFormObservacao("");
    setShowFormTaxa(false);
  }

  function iniciarEdicaoTaxa(t: TaxaContratadaDb) {
    setTaxaEditandoId(t.id);
    setFormBandeira(t.bandeira);
    setFormModalidade(t.modalidade);
    setFormTaxaPercentual(t.taxa_percentual !== null ? String(t.taxa_percentual) : "");
    setFormPrazoDias(t.prazo_dias !== null ? String(t.prazo_dias) : "");
    setFormPrazoTipo(t.prazo_tipo ?? "corridos");
    setFormObservacao(t.observacao ?? "");
    setShowFormTaxa(true);
  }

  async function handleSalvarTaxa(e: React.FormEvent) {
    e.preventDefault();
    if (!formBandeira.trim()) {
      avisar({ tipo: "erro", texto: "Informe a bandeira." });
      return;
    }
    const dados = {
      bandeira: formBandeira.trim(),
      modalidade: formModalidade,
      taxa_percentual: formTaxaPercentual ? Number(formTaxaPercentual.replace(",", ".")) : null,
      prazo_dias: formPrazoDias ? parseInt(formPrazoDias, 10) : null,
      prazo_tipo: formPrazoDias ? formPrazoTipo : null,
      observacao: formObservacao || null,
      atualizado_em: new Date().toISOString(),
    };
    const { error } = taxaEditandoId
      ? await supabase.from("cartao_taxa_contratada").update(dados).eq("id", taxaEditandoId)
      : await supabase.from("cartao_taxa_contratada").insert(dados);
    if (error) {
      avisar({ tipo: "erro", texto: error.message.includes("duplicate") ? "Já existe uma taxa cadastrada para essa bandeira/modalidade." : error.message });
      return;
    }
    avisar({ tipo: "sucesso", texto: "Taxa salva." });
    limparFormTaxa();
    carregarTaxas();
  }

  // Desativa em vez de apagar -- mesmo padrão de "ativo" usado em
  // maquinas/categorias no resto do sistema. Uma taxa contratada pode já ter
  // sido usada pra calcular valor_liquido/data_prevista de transações
  // importadas; apagar o cadastro perderia esse rastro sem motivo.
  async function handleAlternarAtivaTaxa(t: TaxaContratadaDb) {
    if (t.ativo && !confirm("Desativar esta taxa contratada? Ela some das opções de aplicação, mas fica no histórico.")) return;
    const { error } = await supabase.from("cartao_taxa_contratada").update({ ativo: !t.ativo, atualizado_em: new Date().toISOString() }).eq("id", t.id);
    if (error) {
      avisar({ tipo: "erro", texto: error.message });
      return;
    }
    avisar({ tipo: "sucesso", texto: t.ativo ? "Taxa desativada." : "Taxa reativada." });
    carregarTaxas();
  }

  // Backfill: transações (tipicamente Voucher) que ficaram sem valor líquido
  // e sem data prevista porque o arquivo da adquirente não informa taxa/prazo
  // -- roda só depois que o usuário cadastra a taxa aqui, nunca inventa um
  // número sozinho antes disso.
  async function handleAplicarRetroativo(taxa: TaxaContratadaDb) {
    if (taxa.taxa_percentual === null || taxa.prazo_dias === null || !taxa.prazo_tipo) {
      avisar({ tipo: "erro", texto: "Preencha taxa e prazo antes de aplicar." });
      return;
    }
    setAplicandoRetroativo(taxa.id);
    try {
      const { data: pendentes, error: erroPendentes } = await supabase
        .from("cartao_transacao")
        .select("id, data_hora_venda, valor_bruto")
        .eq("bandeira", taxa.bandeira)
        .eq("modalidade", taxa.modalidade)
        .is("data_prevista_pagamento", null)
        .limit(LIMITE_LINHAS);
      if (erroPendentes) throw new Error(erroPendentes.message);
      if (!pendentes || pendentes.length === 0) {
        avisar({ tipo: "sucesso", texto: "Nenhuma transação pendente para essa bandeira/modalidade." });
        return;
      }

      const { data: feriadosRaw } = await supabase.from("feriados").select("data");
      const feriadosSet = new Set((feriadosRaw ?? []).map((f) => f.data as string));

      let atualizadas = 0;
      for (const p of pendentes) {
        const dataVenda = (p.data_hora_venda as string).slice(0, 10);
        const dataPrevista = calcularDataPrevista(dataVenda, taxa.modalidade, feriadosSet, {
          prazoDias: taxa.prazo_dias,
          prazoTipo: taxa.prazo_tipo,
        });
        const valorBruto = p.valor_bruto as number;
        const valorTaxaCalc = Math.round(valorBruto * (taxa.taxa_percentual / 100) * 100) / 100;
        const valorLiquido = Math.round((valorBruto - valorTaxaCalc) * 100) / 100;
        const { error } = await supabase
          .from("cartao_transacao")
          .update({ valor_taxa: valorTaxaCalc, valor_liquido: valorLiquido, data_prevista_pagamento: dataPrevista })
          .eq("id", p.id);
        if (!error) atualizadas++;
      }
      avisar({ tipo: "sucesso", texto: `${atualizadas} de ${pendentes.length} transação(ões) atualizada(s) com a taxa cadastrada.` });
    } catch (e) {
      avisar({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao aplicar retroativamente." });
    } finally {
      setAplicandoRetroativo(null);
    }
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Conciliação de Cartão</h1>
        <p className="text-[var(--color-text-muted)] text-sm mt-1">
          Provisão e conferência de recebíveis da maquininha contra o extrato bancário — respeita fins de semana e feriados.
        </p>
      </div>

      {mensagem && (
        <div
          className={`px-4 py-3 rounded-xl text-sm font-medium border ${
            mensagem.tipo === "sucesso" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {mensagem.texto}
        </div>
      )}

      <div className="flex gap-1 border-b border-[var(--color-border)]">
        {(
          [
            ["importar", "Importar"],
            ["transacoes", "Transações"],
            ["conciliacao", "Provisão × Recebido"],
            ["taxas", "Taxas contratadas"],
          ] as const
        ).map(([valor, label]) => (
          <button
            key={valor}
            onClick={() => setAba(valor)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition ${
              aba === valor ? "border-blue-500 text-blue-600" : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {aba === "importar" && (
        <div className="space-y-6">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-2xl">
            <h2 className="font-semibold text-sm mb-1">Importar relatórios da maquininha</h2>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              O <strong>Detalhado</strong> é obrigatório (transação a transação, com NSU e status). O <strong>Consolidado</strong> é
              opcional e só serve pra conferir se a soma bate — não é gravado como transação.
            </p>

            <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Relatório Detalhado (obrigatório)</label>
            <input
              ref={inputDetalhadoRef}
              type="file"
              accept=".xlsx"
              disabled={isReadOnly}
              onChange={(e) => setArquivoDetalhado(e.target.files?.[0] ?? null)}
              className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:text-xs file:font-semibold"
            />

            <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Relatório Consolidado (opcional, mesmo período)</label>
            <input
              ref={inputConsolidadoRef}
              type="file"
              accept=".xlsx"
              disabled={isReadOnly}
              onChange={(e) => setArquivoConsolidado(e.target.files?.[0] ?? null)}
              className="w-full text-sm mb-5 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700 file:text-xs file:font-semibold"
            />

            <button
              onClick={handleAnalisar}
              disabled={isReadOnly || analisando || !arquivoDetalhado}
              className="w-full px-4 py-2.5 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-sm font-semibold disabled:opacity-50"
            >
              {analisando ? "Lendo arquivo(s)..." : "Analisar"}
            </button>
          </div>

          {previewDetalhado && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 max-w-2xl">
              <h3 className="font-semibold text-sm mb-3">Prévia — {arquivoDetalhado?.name}</h3>
              <div className="grid grid-cols-3 gap-3 text-center mb-3">
                <div className="p-3 rounded-xl bg-[var(--color-bg)]">
                  <p className="text-lg font-bold">{previewDetalhado.transacoes.length}</p>
                  <p className="text-[11px] text-[var(--color-text-muted)]">transações</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--color-bg)]">
                  <p className="text-lg font-bold">{previewDetalhado.transacoes.filter((t) => t.origemPlanilha === "cartoes").length}</p>
                  <p className="text-[11px] text-[var(--color-text-muted)]">cartão</p>
                </div>
                <div className="p-3 rounded-xl bg-[var(--color-bg)]">
                  <p className="text-lg font-bold">{previewDetalhado.transacoes.filter((t) => t.origemPlanilha === "voucher").length}</p>
                  <p className="text-[11px] text-[var(--color-text-muted)]">voucher</p>
                </div>
              </div>
              <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                Pix não é importado por este módulo (isolado por não ser conciliável contra o extrato sem um identificador em comum).
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Período: {formatarData(previewDetalhado.periodoInicio)} a {formatarData(previewDetalhado.periodoFim)}
              </p>
              {previewDetalhado.avisos.length > 0 && (
                <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800">
                  <p className="font-semibold mb-1">{previewDetalhado.avisos.length} aviso(s) de leitura:</p>
                  <ul className="list-disc list-inside space-y-0.5 max-h-32 overflow-y-auto">
                    {previewDetalhado.avisos.slice(0, 20).map((a, i) => (
                      <li key={i}>{a}</li>
                    ))}
                  </ul>
                </div>
              )}

              {comparacaoSomas && (
                <div className="mt-4">
                  <p className="text-xs font-semibold mb-2">Prova de soma (Detalhado × Consolidado):</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                          <th className="py-1.5 pr-2">Bandeira</th>
                          <th className="py-1.5 pr-2">Modalidade</th>
                          <th className="py-1.5 pr-2 text-right">Detalhado</th>
                          <th className="py-1.5 pr-2 text-right">Consolidado</th>
                          <th className="py-1.5 text-right">Diferença</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparacaoSomas.map((c, i) => (
                          <tr key={i} className={`border-b border-[var(--color-border)] last:border-0 ${!c.ok ? "bg-red-50" : ""}`}>
                            <td className="py-1.5 pr-2">{c.bandeira}</td>
                            <td className="py-1.5 pr-2">{c.modalidade}</td>
                            <td className="py-1.5 pr-2 text-right">{formatarMoeda(c.somaDetalhado)}</td>
                            <td className="py-1.5 pr-2 text-right">{formatarMoeda(c.somaConsolidado)}</td>
                            <td className={`py-1.5 text-right font-semibold ${c.ok ? "text-emerald-700" : "text-red-700"}`}>
                              {formatarMoeda(c.diferenca)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className={`mt-2 text-xs font-semibold ${comparacaoSomas.every((c) => c.ok) ? "text-emerald-700" : "text-red-700"}`}>
                    {comparacaoSomas.every((c) => c.ok)
                      ? "✓ Todas as somas batem."
                      : "🚨 Alguma soma não bate — confira antes de importar."}
                  </p>
                </div>
              )}

              {!isReadOnly && (
                <button
                  onClick={handleConfirmarImportacao}
                  disabled={importando}
                  className="w-full mt-4 px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white font-semibold disabled:opacity-50 text-sm"
                >
                  {importando ? "Importando..." : "Confirmar importação"}
                </button>
              )}
            </div>
          )}

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-[var(--color-border)]">
              <h3 className="font-semibold text-sm">Histórico de importações</h3>
            </div>
            {importacoes.length === 0 ? (
              <EmptyState variant="search" title="Nenhuma importação ainda" compact />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-4 py-2.5 font-semibold">Importado em</th>
                    <th className="px-4 py-2.5 font-semibold">Tipo</th>
                    <th className="px-4 py-2.5 font-semibold">Arquivo</th>
                    <th className="px-4 py-2.5 font-semibold">Período</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Linhas</th>
                  </tr>
                </thead>
                <tbody>
                  {importacoes.map((imp) => (
                    <tr key={imp.id} className="border-b border-[var(--color-border)] last:border-0">
                      <td className="px-4 py-2.5 whitespace-nowrap">{formatarDataHora(imp.importado_em)}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${
                            imp.tipo_arquivo === "detalhado" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-gray-100 text-gray-600 border-gray-200"
                          }`}
                        >
                          {imp.tipo_arquivo}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{imp.nome_arquivo}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        {formatarData(imp.periodo_inicio)} a {formatarData(imp.periodo_fim)}
                      </td>
                      <td className="px-4 py-2.5 text-right">{imp.total_linhas_importadas}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {aba === "transacoes" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex flex-wrap gap-3 items-end">
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">Origem</label>
              <select
                value={filtroOrigem}
                onChange={(e) => setFiltroOrigem(e.target.value as typeof filtroOrigem)}
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs"
              >
                <option value="todas">Todas</option>
                <option value="cartoes">Cartão</option>
                <option value="voucher">Voucher</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">Status</label>
              <select
                value={filtroStatus}
                onChange={(e) => setFiltroStatus(e.target.value as typeof filtroStatus)}
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs"
              >
                <option value="todos">Todos</option>
                <option value="aprovada">Aprovada</option>
                <option value="negada">Negada</option>
                <option value="estornada">Estornada</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">Bandeira</label>
              <input
                value={filtroBandeira}
                onChange={(e) => setFiltroBandeira(e.target.value)}
                placeholder="Visa, Mastercard..."
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs w-32"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">De</label>
              <input type="date" value={filtroDataInicio} onChange={(e) => setFiltroDataInicio(e.target.value)} className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-[var(--color-text-muted)] mb-1">Até</label>
              <input type="date" value={filtroDataFim} onChange={(e) => setFiltroDataFim(e.target.value)} className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs" />
            </div>
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            {carregandoTransacoes ? (
              <div className="skeleton h-32 rounded-xl m-4" />
            ) : transacoes.length === 0 ? (
              <EmptyState variant="search" title="Nenhuma transação encontrada" description="Importe um relatório na aba Importar ou ajuste os filtros." compact />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                      <th className="px-3 py-2.5 font-semibold">Data/hora</th>
                      <th className="px-3 py-2.5 font-semibold">Origem</th>
                      <th className="px-3 py-2.5 font-semibold">Bandeira</th>
                      <th className="px-3 py-2.5 font-semibold">Modalidade</th>
                      <th className="px-3 py-2.5 font-semibold">Comprovante</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Bruto</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Taxa</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Líquido</th>
                      <th className="px-3 py-2.5 font-semibold">Previsão</th>
                      <th className="px-3 py-2.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transacoes.map((t) => {
                      const badge = badgeStatusTransacao(t.status_transacao);
                      const divergeDia = t.data_prevista_calculada && t.data_prevista_pagamento && t.data_prevista_calculada !== t.data_prevista_pagamento;
                      return (
                        <tr key={t.id} className="border-b border-[var(--color-border)] last:border-0">
                          <td className="px-3 py-2 whitespace-nowrap">{formatarDataHora(t.data_hora_venda)}</td>
                          <td className="px-3 py-2">{LABEL_ORIGEM[t.origem_planilha]}</td>
                          <td className="px-3 py-2">{t.bandeira}</td>
                          <td className="px-3 py-2">{LABEL_MODALIDADE[t.modalidade]}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{t.numero_comprovante ?? "—"}</td>
                          <td className="px-3 py-2 text-right">{formatarMoeda(t.valor_bruto)}</td>
                          <td className="px-3 py-2 text-right text-[var(--color-text-muted)]">{t.valor_taxa !== null ? formatarMoeda(t.valor_taxa) : "—"}</td>
                          <td className="px-3 py-2 text-right font-medium">{t.valor_liquido !== null ? formatarMoeda(t.valor_liquido) : "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap" title={divergeDia ? `Nosso cálculo: ${formatarData(t.data_prevista_calculada)}` : undefined}>
                            {formatarData(t.data_prevista_pagamento)}
                            {divergeDia && <span className="ml-1 text-amber-600">⚠</span>}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${badge.classe}`}>{badge.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {transacoes.length >= LIMITE_LINHAS && (
                  <p className="px-4 py-2 text-[11px] text-amber-700 bg-amber-50">
                    Mostrando apenas as últimas {LIMITE_LINHAS} transações — refine os filtros pra ver um período específico.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {aba === "conciliacao" && (
        <div className="space-y-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-4 text-sm">
              <div>
                <p className="text-[11px] text-[var(--color-text-muted)]">Previsto</p>
                <p className="font-bold">{formatarMoeda(totalPrevisto)}</p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-muted)]">Recebido</p>
                <p className="font-bold">{formatarMoeda(totalRecebido)}</p>
              </div>
              <div>
                <p className="text-[11px] text-[var(--color-text-muted)]">Sem depósito (🚨 prejuízo potencial)</p>
                <p className="font-bold text-red-700">{formatarMoeda(totalSemDeposito)}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={filtroStatusConciliacao}
                onChange={(e) => setFiltroStatusConciliacao(e.target.value as typeof filtroStatusConciliacao)}
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-xs"
              >
                <option value="todos">Todos os status</option>
                <option value="conciliado">Conciliado</option>
                <option value="conciliado_manual">Conciliado (manual)</option>
                <option value="divergente">Divergente</option>
                <option value="sem_deposito_encontrado">Sem depósito</option>
                <option value="multiplos_candidatos">Escolher manualmente</option>
                <option value="aguardando">Aguardando (ainda não venceu)</option>
              </select>
              {!isReadOnly && (
                <button
                  onClick={handleRecalcularConciliacao}
                  disabled={recalculando}
                  className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {recalculando ? "Recalculando..." : "Recalcular conciliação"}
                </button>
              )}
            </div>
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            {carregandoConciliacoes ? (
              <div className="skeleton h-32 rounded-xl m-4" />
            ) : conciliacoesFiltradas.length === 0 ? (
              <EmptyState
                variant="search"
                title="Nenhuma conciliação calculada ainda"
                description="Importe as transações e clique em Recalcular conciliação."
                compact
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                      <th className="px-3 py-2.5 font-semibold">Data prevista</th>
                      <th className="px-3 py-2.5 font-semibold">Bandeira</th>
                      <th className="px-3 py-2.5 font-semibold">Modalidade</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Previsto</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Recebido</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Diferença</th>
                      <th className="px-3 py-2.5 font-semibold">Lançamento no extrato</th>
                      <th className="px-3 py-2.5 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conciliacoesFiltradas.map((c) => {
                      const badge = badgeStatusConciliacao(c.status);
                      const lancamento = c.extrato_lancamento_id ? lancamentosInfo.get(c.extrato_lancamento_id) : null;
                      return (
                        <tr key={c.id} className="border-b border-[var(--color-border)] last:border-0">
                          <td className="px-3 py-2 whitespace-nowrap">{formatarData(c.data_prevista)}</td>
                          <td className="px-3 py-2">{c.bandeira}</td>
                          <td className="px-3 py-2">{LABEL_MODALIDADE[c.modalidade] ?? c.modalidade}</td>
                          <td className="px-3 py-2 text-right">{formatarMoeda(c.valor_previsto)}</td>
                          <td className="px-3 py-2 text-right">{c.valor_recebido !== null ? formatarMoeda(c.valor_recebido) : "—"}</td>
                          <td className={`px-3 py-2 text-right font-medium ${c.diferenca && c.diferenca < 0 ? "text-red-700" : c.diferenca && c.diferenca > 0 ? "text-amber-700" : ""}`}>
                            {c.diferenca !== null ? formatarMoeda(c.diferenca) : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {c.status === "multiplos_candidatos" && (c.candidatos_ids?.length ?? 0) > 0 ? (
                              <select
                                disabled={isReadOnly}
                                defaultValue=""
                                onChange={(e) => e.target.value && handleEscolherManual(c.id, e.target.value)}
                                className="px-2 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[11px]"
                              >
                                <option value="" disabled>
                                  Escolher lançamento...
                                </option>
                                {(c.candidatos_ids ?? []).map((id) => {
                                  const info = lancamentosInfo.get(id);
                                  if (!info) return null;
                                  return (
                                    <option key={id} value={id}>
                                      {formatarData(info.data_lancamento)} · {formatarMoeda(info.valor)} · {info.descricao.slice(0, 30)}
                                    </option>
                                  );
                                })}
                              </select>
                            ) : lancamento ? (
                              <span title={lancamento.descricao}>
                                {formatarData(lancamento.data_lancamento)} · {formatarMoeda(lancamento.valor)}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${badge.classe}`}>{badge.label}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {aba === "taxas" && (
        <div className="space-y-4">
          {!isReadOnly && (
            <div className="flex justify-end">
              <button
                onClick={() => (showFormTaxa ? limparFormTaxa() : setShowFormTaxa(true))}
                className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 text-white text-sm font-semibold"
              >
                {showFormTaxa ? "Cancelar" : "+ Nova taxa"}
              </button>
            </div>
          )}

          {showFormTaxa && (
            <form onSubmit={handleSalvarTaxa} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Bandeira</label>
                <input value={formBandeira} onChange={(e) => setFormBandeira(e.target.value)} placeholder="Vr Beneficios" className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm" required />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Modalidade</label>
                <select value={formModalidade} onChange={(e) => setFormModalidade(e.target.value as ModalidadeCartao)} className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm">
                  <option value="voucher">Voucher</option>
                  <option value="credito">Crédito</option>
                  <option value="debito">Débito</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Taxa (%)</label>
                <input value={formTaxaPercentual} onChange={(e) => setFormTaxaPercentual(e.target.value)} placeholder="ex.: 2,5" className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm" />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Prazo (dias)</label>
                  <input value={formPrazoDias} onChange={(e) => setFormPrazoDias(e.target.value)} placeholder="ex.: 1" className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Tipo</label>
                  <select value={formPrazoTipo} onChange={(e) => setFormPrazoTipo(e.target.value as "uteis" | "corridos")} className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm">
                    <option value="corridos">Corridos</option>
                    <option value="uteis">Úteis</option>
                  </select>
                </div>
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Observação</label>
                <input value={formObservacao} onChange={(e) => setFormObservacao(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm" />
              </div>
              <div className="sm:col-span-2">
                <button type="submit" className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold">
                  Salvar
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            {carregandoTaxas ? (
              <div className="skeleton h-32 rounded-xl m-4" />
            ) : taxas.length === 0 ? (
              <EmptyState variant="search" title="Nenhuma taxa cadastrada" description="Cadastre taxa e prazo — necessário sobretudo pro Voucher, que o arquivo da adquirente não informa." compact />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-4 py-2.5 font-semibold">Bandeira</th>
                    <th className="px-4 py-2.5 font-semibold">Modalidade</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Taxa</th>
                    <th className="px-4 py-2.5 font-semibold">Prazo</th>
                    <th className="px-4 py-2.5 font-semibold">Observação</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    {!isReadOnly && <th className="px-4 py-2.5 font-semibold text-right">Ações</th>}
                  </tr>
                </thead>
                <tbody>
                  {taxas.map((t) => (
                    <tr key={t.id} className={`border-b border-[var(--color-border)] last:border-0 ${!t.ativo ? "opacity-50" : ""}`}>
                      <td className="px-4 py-2.5">{t.bandeira}</td>
                      <td className="px-4 py-2.5">{LABEL_MODALIDADE[t.modalidade]}</td>
                      <td className="px-4 py-2.5 text-right">{t.taxa_percentual !== null ? `${t.taxa_percentual}%` : "—"}</td>
                      <td className="px-4 py-2.5">{t.prazo_dias !== null ? `${t.prazo_dias} dia(s) ${t.prazo_tipo}` : "—"}</td>
                      <td className="px-4 py-2.5 text-[var(--color-text-muted)]">{t.observacao ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold ${t.ativo ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-600 border-gray-200"}`}>
                          {t.ativo ? "Ativa" : "Inativa"}
                        </span>
                      </td>
                      {!isReadOnly && (
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          {t.modalidade === "voucher" && (
                            <button
                              onClick={() => handleAplicarRetroativo(t)}
                              disabled={aplicandoRetroativo === t.id}
                              className="mr-2 px-2 py-1 rounded-lg border border-[var(--color-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)] disabled:opacity-50"
                              title="Aplica esta taxa/prazo às transações já importadas que ainda não têm valor líquido"
                            >
                              {aplicandoRetroativo === t.id ? "Aplicando..." : "Aplicar ao já importado"}
                            </button>
                          )}
                          <button onClick={() => iniciarEdicaoTaxa(t)} className="mr-2 px-2 py-1 rounded-lg border border-[var(--color-border)] text-[11px] font-medium hover:bg-[var(--hover-bg)]">
                            Editar
                          </button>
                          <button
                            onClick={() => handleAlternarAtivaTaxa(t)}
                            className={`px-2 py-1 rounded-lg border text-[11px] font-medium ${t.ativo ? "border-red-200 text-red-600 hover:bg-red-50" : "border-emerald-200 text-emerald-700 hover:bg-emerald-50"}`}
                          >
                            {t.ativo ? "Desativar" : "Reativar"}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
            <div className="px-5 py-3 border-b border-[var(--color-border)]">
              <h3 className="font-semibold text-sm">Auditoria: taxa contratada × taxa efetivamente cobrada</h3>
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                Só aparece aqui quem tem taxa cadastrada acima e ativa. Compara a média ponderada realmente cobrada nas transações
                importadas contra o que você cadastrou — o sistema não tem como saber sozinho o que foi contratado.
              </p>
            </div>
            {carregandoAuditoria ? (
              <div className="skeleton h-24 rounded-xl m-4" />
            ) : auditoria.length === 0 ? (
              <EmptyState
                variant="search"
                title="Nenhuma taxa contratada cadastrada ainda"
                description="Cadastre a taxa real do seu contrato com a adquirente acima para habilitar esta auditoria."
                compact
              />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-4 py-2.5 font-semibold">Bandeira</th>
                    <th className="px-4 py-2.5 font-semibold">Modalidade</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Contratada</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Cobrada (média)</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Diferença</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Total bruto no período</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Excedente estimado</th>
                  </tr>
                </thead>
                <tbody>
                  {auditoria.map((a, i) => (
                    <tr key={i} className={`border-b border-[var(--color-border)] last:border-0 ${a.status === "acima_do_contrato" ? "bg-red-50" : ""}`}>
                      <td className="px-4 py-2.5">{a.bandeira}</td>
                      <td className="px-4 py-2.5">{LABEL_MODALIDADE[a.modalidade]}</td>
                      <td className="px-4 py-2.5 text-right">{a.taxaContratada}%</td>
                      <td className="px-4 py-2.5 text-right">{a.taxaEfetivaMedia}%</td>
                      <td className={`px-4 py-2.5 text-right font-medium ${a.status === "acima_do_contrato" ? "text-red-700" : "text-emerald-700"}`}>
                        {a.diferencaPontos > 0 ? "+" : ""}
                        {a.diferencaPontos}pp
                      </td>
                      <td className="px-4 py-2.5 text-right">{formatarMoeda(a.totalBruto)}</td>
                      <td className={`px-4 py-2.5 text-right font-semibold ${a.status === "acima_do_contrato" ? "text-red-700" : ""}`}>
                        {a.status === "acima_do_contrato" ? `🚨 ${formatarMoeda(a.valorExcedente)}` : "✓ dentro do contrato"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
