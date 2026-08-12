"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseOfx, decodificarOfx, OfxParseError } from "@/lib/ofx";
import { aplicarRegras, type RegraExtrato as RegraMotor, type LancamentoClassificavel } from "@/lib/regras-extrato";
import { calcularTipoMovimentacao, agruparResumoPorDia } from "@/lib/preview-movimentacao";
import EmptyState from "@/components/empty-state";

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
  const [resumoImportacao, setResumoImportacao] = useState<{ lidas: number; novas: number; duplicadas: number; avisos: string[] } | null>(null);
  const [mostrarNovaConta, setMostrarNovaConta] = useState(false);
  const [novaContaBanco, setNovaContaBanco] = useState("santander");
  const [novaContaApelido, setNovaContaApelido] = useState("");
  const [novaContaAgencia, setNovaContaAgencia] = useState("");
  const [novaContaNumero, setNovaContaNumero] = useState("");
  const [criandoConta, setCriandoConta] = useState(false);
  const inputArquivoRef = useRef<HTMLInputElement>(null);

  // Lançamentos
  const [lancamentos, setLancamentos] = useState<Lancamento[]>([]);
  const [carregandoLancamentos, setCarregandoLancamentos] = useState(false);
  const [filtroContaId, setFiltroContaId] = useState("");
  const [filtroStatus, setFiltroStatus] = useState<"todos" | "nao_classificado" | "classificado" | "ignorado">("todos");
  const [resumo, setResumo] = useState({ total: 0, classificados: 0, naoClassificados: 0, automaticos: 0 });
  const [mostrarResumoDiario, setMostrarResumoDiario] = useState(false);
  const [categoriaDiaExpandida, setCategoriaDiaExpandida] = useState<string | null>(null);
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
  }, [filtroContaId, filtroStatus]);

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
        .select("id, conta_id, descricao_normalizada, valor, status")
        .eq("status", "nao_classificado");
      if (filtroContaId) query = query.eq("conta_id", filtroContaId);
      const { data: candidatos, error } = await query;
      if (error) throw new Error(error.message);

      const qtd = await classificarPorRegras((candidatos ?? []) as LancamentoClassificavel[]);
      setMensagem({
        tipo: "sucesso",
        texto: qtd > 0 ? `${qtd} lançamento(s) classificado(s) automaticamente.` : "Nenhum lançamento pendente casou com as regras ativas.",
      });
      await refrescarTudo();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro ao reprocessar regras." });
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

      const linhas = parsed.transacoes.map((t) => ({
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
        .select("id, conta_id, descricao_normalizada, valor, status");

      if (erroUpsert) throw new Error(erroUpsert.message);

      const novas = inseridos?.length ?? 0;
      const duplicadas = linhas.length - novas;

      const { error: erroImportacao } = await supabase.from("extrato_importacao").insert({
        conta_id: contaImportId,
        nome_arquivo: arquivo.name,
        periodo_inicio: parsed.conta.periodoInicio,
        periodo_fim: parsed.conta.periodoFim,
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

      setResumoImportacao({ lidas: linhas.length, novas, duplicadas, avisos: parsed.avisos });
      setMensagem({
        tipo: "sucesso",
        texto:
          `${linhas.length} lidas · ${novas} novas · ${duplicadas} já existentes` +
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
              </p>
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

          {resumoPorDia.length > 0 && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setMostrarResumoDiario((v) => !v)}
                className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-semibold hover:bg-[var(--hover-bg)]"
              >
                {mostrarResumoDiario ? "▲" : "▼"} Resumo diário por categoria ({resumoPorDia.length} dia{resumoPorDia.length > 1 ? "s" : ""})
              </button>
              {lancamentos.length >= LIMITE_LANCAMENTOS && (
                <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                  Mostrando apenas os últimos {LIMITE_LANCAMENTOS} lançamentos — o resumo do dia mais antigo pode estar incompleto.
                </p>
              )}
              {mostrarResumoDiario && (
                <div className="mt-2 space-y-2 max-h-96 overflow-y-auto">
                  {resumoPorDia.map((dia) => (
                    <div key={dia.data} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs font-semibold">{formatarData(dia.data)}</span>
                        <span className={`text-xs font-bold ${dia.totalDia < 0 ? "text-red-600" : "text-emerald-600"}`}>
                          {formatarMoeda(dia.totalDia)}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {dia.categorias.map((c) => {
                          const chave = `${dia.data}|${c.categoria}`;
                          const expandida = categoriaDiaExpandida === chave;
                          return (
                            <div key={c.categoria}>
                              <button
                                type="button"
                                onClick={() => setCategoriaDiaExpandida(expandida ? null : chave)}
                                className="w-full flex justify-between items-center text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                                title="Ver os lançamentos que compõem este total"
                              >
                                <span>
                                  {expandida ? "▾" : "▸"} {c.categoria} <span className="text-[10px]">×{c.quantidade}</span>
                                </span>
                                <span className={c.total < 0 ? "text-red-500" : "text-emerald-600"}>{formatarMoeda(c.total)}</span>
                              </button>
                              {expandida && (
                                <div className="mt-1 mb-1.5 ml-3.5 pl-2 border-l border-[var(--color-border)] space-y-0.5">
                                  {c.lancamentos.map((l) => (
                                    <div key={l.id} className="flex justify-between gap-3 text-[10px] text-[var(--color-text-muted)]">
                                      <span className="truncate" title={l.descricao}>
                                        {l.descricao}
                                      </span>
                                      <span className="shrink-0">{formatarMoeda(l.valor)}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {carregandoLancamentos ? (
            <div className="skeleton h-40 rounded-xl" />
          ) : lancamentos.length === 0 ? (
            <EmptyState variant="search" title="Nenhum lançamento" description="Importe um extrato .ofx na aba Importar para começar." compact />
          ) : (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-3 py-2.5 font-semibold">Data</th>
                    <th className="px-3 py-2.5 font-semibold">Descrição</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Valor</th>
                    <th className="px-3 py-2.5 font-semibold">Categoria</th>
                    <th className="px-3 py-2.5 font-semibold">Origem</th>
                    <th className="px-3 py-2.5 font-semibold">Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {lancamentos.map((l) => (
                    <tr key={l.id} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatarData(l.data_lancamento)}</td>
                      <td className="px-3 py-2.5 max-w-[240px] truncate" title={l.descricao}>
                        {l.descricao}
                      </td>
                      <td className={`px-3 py-2.5 text-right whitespace-nowrap font-semibold ${l.valor < 0 ? "text-red-600" : "text-emerald-600"}`}>
                        {formatarMoeda(l.valor)}
                      </td>
                      <td className="px-3 py-2.5">
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
                      <td className="px-3 py-2.5 whitespace-nowrap text-[10px] text-[var(--color-text-muted)]">
                        {l.status === "ignorado" ? "ignorado" : l.regra_id ? "regra" : l.categoria ? "manual" : "—"}
                      </td>
                      <td className="px-3 py-2.5">
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
