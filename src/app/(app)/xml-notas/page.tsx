"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { parseNFe, decodificarXml, NFeParseError, type NFeParseResult } from "@/lib/xml-nfe";
import { extrairArquivosZip, ZipParseError } from "@/lib/zip";
import EmptyState from "@/components/empty-state";
import { registrarLog } from "@/lib/audit";
import { encontrarCategoriaPorFornecedor, encontrarContasPagarCandidatas, type RegraFornecedor } from "@/lib/xml-regra-fornecedor";

interface Duplicata {
  id: string;
  numero: string | null;
  vencimento: string | null;
  valor: number;
  status: string;
  conta_pagar_id: string | null;
  contas_pagar_candidatas: string[] | null;
}

interface Nota {
  id: string;
  chave_acesso: string;
  fornecedor_nome: string | null;
  fornecedor_cnpj: string | null;
  numero_nota: string | null;
  valor_total: number | null;
  emitida_em: string | null;
  criado_em: string;
  xml_duplicata: Duplicata[];
}

type Mensagem = { tipo: "sucesso" | "erro"; texto: string } | null;

function formatarMoeda(v: number | null) {
  if (v == null) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarData(iso: string | null) {
  if (!iso) return "—";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

// criado_em é timestamptz (ex.: "2026-08-13 01:02:29.76+00"), diferente de
// emitida_em/vencimento que são datas puras -- não dá pra usar formatarData.
function formatarDataCadastro(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR");
}

function formatarChave(chave: string) {
  return chave.replace(/(\d{4})(?=\d)/g, "$1 ");
}

// Identifica a parcela que falhou de um jeito que o usuário reconheça na tela.
function descreverParcela(nota: Nota, duplicata: Duplicata) {
  return `${nota.fornecedor_nome ?? "(sem fornecedor)"} · NF-e ${nota.numero_nota ?? "?"} · parcela ${duplicata.numero ?? "(sem número)"}`;
}

// dVenc é opcional na NF-e, mas contas_pagar.data_vencimento é NOT NULL: o
// INSERT dessa parcela vai falhar sempre, e a mensagem crua do Postgres
// ("null value in column ... violates not-null constraint") não diz nada pra
// quem trabalha no financeiro. Traduz esse caso; o resto passa direto.
function explicarFalhaLancamento(duplicata: Duplicata, erro: string | undefined) {
  if (duplicata.vencimento === null) {
    return "esta parcela não tem data de vencimento no XML — lance manualmente em Contas a Pagar.";
  }
  return erro ?? "erro desconhecido.";
}

const MAX_ARQUIVOS_TAMANHO = 10 * 1024 * 1024; // 10 MB por arquivo

export default function XmlNotasPage() {
  const supabase = createClient();

  const [role, setRole] = useState<string | null>(null);
  const podeEscrever = role === "master" || role === "funcionario";

  const [aba, setAba] = useState<"importar" | "notas" | "regras">("importar");
  const [mensagem, setMensagem] = useState<Mensagem>(null);

  const [importando, setImportando] = useState(false);
  const [resumoImportacao, setResumoImportacao] = useState<{
    arquivosLidos: number;
    notasEncontradas: number;
    novas: number;
    duplicadas: number;
    erros: string[];
  } | null>(null);
  const inputArquivosRef = useRef<HTMLInputElement>(null);

  const [notas, setNotas] = useState<Nota[]>([]);
  const [carregandoNotas, setCarregandoNotas] = useState(false);
  const [notaExpandidaId, setNotaExpandidaId] = useState<string | null>(null);

  const [lancando, setLancando] = useState(false);
  const [errosLancamento, setErrosLancamento] = useState<string[]>([]);
  const [resolvendoSuspeita, setResolvendoSuspeita] = useState<{
    duplicata: Duplicata;
    nota: Nota;
    candidatas: { id: string; fornecedor: string; valor: number; data_vencimento: string; status: string }[];
  } | null>(null);
  const [resolvendoAcao, setResolvendoAcao] = useState(false);

  const [categoriasSaida, setCategoriasSaida] = useState<{ id: string; nome: string }[]>([]);
  const [regrasFornecedor, setRegrasFornecedor] = useState<RegraFornecedor[]>([]);
  const [carregandoRegras, setCarregandoRegras] = useState(false);
  const [editandoRegraId, setEditandoRegraId] = useState<string | null>(null);
  const [formRegraFornecedor, setFormRegraFornecedor] = useState({ fornecedor_padrao: "", categoria_id: "" });
  const [salvandoRegra, setSalvandoRegra] = useState(false);

  async function carregarNotas() {
    setCarregandoNotas(true);
    const { data, error } = await supabase
      .from("xml_nota")
      .select("*, xml_duplicata(*)")
      .order("emitida_em", { ascending: false })
      .order("id", { ascending: false })
      .limit(500);
    if (!error && data) setNotas(data as unknown as Nota[]);
    setCarregandoNotas(false);
  }

  async function carregarCategoriasSaida() {
    const { data, error } = await supabase.from("categorias_saida").select("id, nome").eq("ativo", true).order("nome");
    if (!error && data) setCategoriasSaida(data as { id: string; nome: string }[]);
    else if (error) setMensagem({ tipo: "erro", texto: "Erro ao carregar categorias: " + error.message });
  }

  async function carregarRegrasFornecedor() {
    setCarregandoRegras(true);
    const { data, error } = await supabase
      .from("xml_regra_fornecedor")
      .select("id, fornecedor_padrao, categoria_id, ativa")
      .order("fornecedor_padrao");
    if (!error && data) setRegrasFornecedor(data as RegraFornecedor[]);
    else if (error) setMensagem({ tipo: "erro", texto: "Erro ao carregar regras: " + error.message });
    setCarregandoRegras(false);
  }

  function iniciarNovaRegra() {
    setEditandoRegraId(null);
    setFormRegraFornecedor({ fornecedor_padrao: "", categoria_id: "" });
  }

  function iniciarEdicaoRegra(r: RegraFornecedor) {
    setEditandoRegraId(r.id);
    setFormRegraFornecedor({ fornecedor_padrao: r.fornecedor_padrao, categoria_id: r.categoria_id });
  }

  async function handleSalvarRegraFornecedor() {
    if (!formRegraFornecedor.fornecedor_padrao.trim() || !formRegraFornecedor.categoria_id) {
      setMensagem({ tipo: "erro", texto: "Informe o fornecedor padrão e a categoria." });
      return;
    }
    setSalvandoRegra(true);
    const payload = {
      fornecedor_padrao: formRegraFornecedor.fornecedor_padrao.trim(),
      categoria_id: formRegraFornecedor.categoria_id,
    };
    const { error } = editandoRegraId
      ? await supabase.from("xml_regra_fornecedor").update(payload).eq("id", editandoRegraId)
      : await supabase.from("xml_regra_fornecedor").insert({ ...payload, ativa: true });
    setSalvandoRegra(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao salvar regra: " + error.message });
      return;
    }
    await registrarLog({
      acao: editandoRegraId ? "editou" : "criou",
      tabela: "xml_regra_fornecedor",
      registroId: editandoRegraId ?? undefined,
      detalhes: payload.fornecedor_padrao,
    });
    setMensagem({ tipo: "sucesso", texto: editandoRegraId ? "Regra atualizada." : "Regra criada." });
    iniciarNovaRegra();
    await carregarRegrasFornecedor();
  }

  async function handleAlternarAtivaRegra(r: RegraFornecedor) {
    const { error } = await supabase.from("xml_regra_fornecedor").update({ ativa: !r.ativa }).eq("id", r.id);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao atualizar regra: " + error.message });
      return;
    }
    await registrarLog({
      acao: "editou",
      tabela: "xml_regra_fornecedor",
      registroId: r.id,
      detalhes: `${r.fornecedor_padrao} -> ${!r.ativa ? "ativada" : "desativada"}`,
    });
    await carregarRegrasFornecedor();
  }

  async function handleExcluirRegraFornecedor(r: RegraFornecedor) {
    if (!confirm(`Excluir a regra de fornecedor "${r.fornecedor_padrao}"?`)) return;
    const { error } = await supabase.from("xml_regra_fornecedor").delete().eq("id", r.id);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao excluir regra: " + error.message });
      return;
    }
    await registrarLog({ acao: "excluiu", tabela: "xml_regra_fornecedor", registroId: r.id, detalhes: r.fornecedor_padrao });
    await carregarRegrasFornecedor();
  }

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
        setRole(profile?.role ?? null);
      }
    })();
    carregarNotas();
    carregarCategoriasSaida();
    carregarRegrasFornecedor();
  }, []);

  // Por arquivo, não pro lote inteiro: um .zip corrompido não pode derrubar os
  // XMLs que já vieram bons de outros arquivos do mesmo upload -- mesmo padrão
  // de resiliência que já existe no parse de cada NF-e logo abaixo.
  async function coletarXmlsDosArquivos(
    files: File[]
  ): Promise<{ arquivos: { nomeOrigem: string; bytes: Uint8Array }[]; erros: string[] }> {
    const arquivos: { nomeOrigem: string; bytes: Uint8Array }[] = [];
    const erros: string[] = [];
    for (const file of files) {
      const nomeMin = file.name.toLowerCase();
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (nomeMin.endsWith(".xml")) {
          arquivos.push({ nomeOrigem: file.name, bytes });
        } else if (nomeMin.endsWith(".zip")) {
          const entradas = await extrairArquivosZip(bytes, file.name);
          const xmls = entradas.filter((e) => e.nome.toLowerCase().endsWith(".xml"));
          for (const e of xmls) {
            arquivos.push({ nomeOrigem: `${file.name} → ${e.nome}`, bytes: e.bytes });
          }
        }
      } catch (e) {
        erros.push(e instanceof ZipParseError ? e.message : `Erro inesperado ao processar "${file.name}".`);
      }
    }
    return { arquivos, erros };
  }

  async function handleImportar() {
    setMensagem(null);
    setResumoImportacao(null);

    const files = Array.from(inputArquivosRef.current?.files ?? []);
    if (files.length === 0) {
      setMensagem({ tipo: "erro", texto: "Selecione um ou mais arquivos .xml ou .zip." });
      return;
    }
    for (const f of files) {
      const nomeMin = f.name.toLowerCase();
      if (!nomeMin.endsWith(".xml") && !nomeMin.endsWith(".zip")) {
        setMensagem({ tipo: "erro", texto: `Arquivo "${f.name}" rejeitado: apenas .xml e .zip são aceitos.` });
        return;
      }
      if (f.size > MAX_ARQUIVOS_TAMANHO) {
        setMensagem({ tipo: "erro", texto: `Arquivo "${f.name}" rejeitado: maior que 10 MB.` });
        return;
      }
    }

    setImportando(true);
    const erros: string[] = [];
    try {
      const { arquivos: xmls, erros: errosColeta } = await coletarXmlsDosArquivos(files);
      erros.push(...errosColeta);

      const notasParseadas: { resultado: NFeParseResult; xmlBruto: string }[] = [];
      for (const { nomeOrigem, bytes } of xmls) {
        try {
          const texto = decodificarXml(bytes, nomeOrigem);
          const resultado = parseNFe(texto, nomeOrigem);
          notasParseadas.push({ resultado, xmlBruto: texto });
        } catch (e) {
          erros.push(e instanceof NFeParseError ? e.message : `Erro inesperado ao processar "${nomeOrigem}".`);
        }
      }

      if (notasParseadas.length === 0) {
        setResumoImportacao({ arquivosLidos: xmls.length, notasEncontradas: 0, novas: 0, duplicadas: 0, erros });
        setMensagem({ tipo: erros.length > 0 ? "erro" : "sucesso", texto: erros.length > 0 ? "Nenhuma nota válida encontrada." : "Nenhum XML encontrado nos arquivos selecionados." });
        return;
      }

      const { data: { user } } = await supabase.auth.getUser();

      const { data: importacao, error: erroImportacao } = await supabase
        .from("xml_importacao")
        .insert({ origem: "upload_manual", qtd_notas: notasParseadas.length, importado_por: user?.id ?? null })
        .select()
        .single();
      if (erroImportacao) throw new Error(erroImportacao.message);

      const linhasNota = notasParseadas.map(({ resultado, xmlBruto }) => ({
        importacao_id: importacao.id,
        chave_acesso: resultado.chaveAcesso,
        fornecedor_nome: resultado.fornecedorNome,
        fornecedor_cnpj: resultado.fornecedorCnpj,
        numero_nota: resultado.numeroNota,
        valor_total: resultado.valorTotal,
        emitida_em: resultado.emitidaEm,
        xml_bruto: xmlBruto,
      }));

      const { data: notasInseridas, error: erroNota } = await supabase
        .from("xml_nota")
        .upsert(linhasNota, { onConflict: "chave_acesso", ignoreDuplicates: true })
        .select("id, chave_acesso");
      if (erroNota) throw new Error(erroNota.message);

      const novas = notasInseridas?.length ?? 0;
      const duplicadas = linhasNota.length - novas;

      if (notasInseridas && notasInseridas.length > 0) {
        const duplicatasParaInserir = notasInseridas.flatMap((notaInserida) => {
          const original = notasParseadas.find((n) => n.resultado.chaveAcesso === notaInserida.chave_acesso);
          if (!original) return [];
          return original.resultado.duplicatas.map((d) => ({
            nota_id: notaInserida.id,
            numero: d.numero,
            vencimento: d.vencimento,
            valor: d.valor,
            status: "candidata",
          }));
        });
        if (duplicatasParaInserir.length > 0) {
          const { error: erroDup } = await supabase.from("xml_duplicata").insert(duplicatasParaInserir);
          if (erroDup) throw new Error(erroDup.message);
        }
      }

      setResumoImportacao({ arquivosLidos: xmls.length, notasEncontradas: notasParseadas.length, novas, duplicadas, erros });
      setMensagem({
        tipo: "sucesso",
        texto: `${notasParseadas.length} nota(s) lida(s) · ${novas} nova(s) · ${duplicadas} já existente(s)` + (erros.length > 0 ? ` · ${erros.length} arquivo(s) com erro` : ""),
      });
      if (inputArquivosRef.current) inputArquivosRef.current.value = "";
      await carregarNotas();
    } catch (e) {
      setMensagem({ tipo: "erro", texto: e instanceof Error ? e.message : "Erro inesperado ao importar." });
    } finally {
      setImportando(false);
    }
  }

  // Categoria padrão de toda conta a pagar gerada do XML quando nenhuma regra
  // de fornecedor bate -- categoria "Pagamento de boletos" já existe no
  // cadastro (categorias_saida); se por algum motivo tiver sido excluída,
  // volta null e a conta nasce sem categoria, como já acontecia antes.
  function resolverCategoriaPadraoBoletos(): string | null {
    return categoriasSaida.find((c) => c.nome.trim().toLowerCase() === "pagamento de boletos")?.id ?? null;
  }

  // Cria a conta a pagar de UMA duplicata e faz o claim-then-write do vínculo.
  // `statusEsperado` é o status que a duplicata precisa ainda ter na hora de
  // vincular: "candidata" no fluxo em lote, "duplicata_suspeita" quando o
  // humano já revisou e mandou lançar mesmo assim -- é o que impede a duplicata
  // de voltar pro pool de matching automático e ser re-suspeitada pra sempre.
  async function criarContaPagarDeDuplicata(
    nota: Nota,
    duplicata: Duplicata,
    regrasParaMatch: RegraFornecedor[],
    statusEsperado: string,
    categoriaPadraoId: string | null
  ): Promise<{ resultado: "criada" | "corrida_perdida" | "falhou"; erro?: string }> {
    // Sem regra específica de fornecedor, cai em "Pagamento de boletos" em vez
    // de ficar sem categoria -- todo XML lançado aqui é, por natureza, boleto
    // de fornecedor (nunca outra coisa). Regra específica sempre tem prioridade;
    // o usuário ainda pode reclassificar manualmente na tela de Contas a Pagar.
    const categoriaId = encontrarCategoriaPorFornecedor(nota.fornecedor_nome ?? "", regrasParaMatch) ?? categoriaPadraoId;

    const { data: contaCriada, error: erroConta } = await supabase
      .from("contas_pagar")
      .insert({
        fornecedor: nota.fornecedor_nome ?? "(sem nome no XML)",
        descricao: `NF-e ${nota.numero_nota ?? "?"} - parcela ${duplicata.numero ?? "(sem número)"}`,
        valor: duplicata.valor,
        data_vencimento: duplicata.vencimento,
        status: "pendente",
        categoria_id: categoriaId,
        observacao: `Gerado a partir do XML da NF-e (chave ${nota.chave_acesso})`,
      })
      .select("id")
      .single();
    if (erroConta || !contaCriada) {
      return { resultado: "falhou", erro: erroConta?.message ?? "não foi possível criar a conta a pagar." };
    }

    const { data: linhasAtualizadas, error: erroVinculo } = await supabase
      .from("xml_duplicata")
      .update({ status: "lancada", conta_pagar_id: contaCriada.id })
      .eq("id", duplicata.id)
      .eq("status", statusEsperado)
      .select("id");

    // Erro real de vínculo (rede/timeout/5xx) e corrida perdida caem no MESMO
    // rollback: nos dois casos a conta acabou de ser criada e ninguém aponta
    // pra ela -- deixar passar geraria órfã e um segundo lançamento no próximo clique.
    if (erroVinculo || !linhasAtualizadas || linhasAtualizadas.length === 0) {
      const { error: erroExclusao } = await supabase.from("contas_pagar").delete().eq("id", contaCriada.id);
      if (erroExclusao) {
        await registrarLog({
          acao: "excluiu",
          tabela: "contas_pagar",
          registroId: contaCriada.id,
          detalhes: `Falha ao desfazer conta a pagar órfã (${erroVinculo ? "erro ao vincular: " + erroVinculo.message : "perdeu corrida de vínculo"} com xml_duplicata ${duplicata.id}): ${erroExclusao.message}`,
        });
      }
      return erroVinculo ? { resultado: "falhou", erro: erroVinculo.message } : { resultado: "corrida_perdida" };
    }

    await registrarLog({
      acao: "criou",
      tabela: "contas_pagar",
      registroId: contaCriada.id,
      detalhes: `${nota.fornecedor_nome ?? "?"} - ${formatarMoeda(duplicata.valor)} gerado a partir do XML da NF-e ${nota.numero_nota ?? "?"}`,
    });
    return { resultado: "criada" };
  }

  async function handleLancarContasPagar() {
    if (!podeEscrever) return;
    setLancando(true);
    setMensagem(null);
    setErrosLancamento([]);

    try {
      const candidatas: { duplicata: Duplicata; nota: Nota }[] = [];
      let semBoleto = 0;
      for (const nota of notas) {
        if (nota.xml_duplicata.length === 0) {
          semBoleto++;
          continue;
        }
        for (const d of nota.xml_duplicata) {
          if (d.status === "candidata") candidatas.push({ duplicata: d, nota });
        }
      }

      if (candidatas.length === 0) {
        setMensagem({
          tipo: "sucesso",
          texto:
            semBoleto > 0
              ? `Nada pra lançar agora. ${semBoleto} nota(s) sem boleto no XML precisam ser lançadas manualmente.`
              : "Nada pendente pra lançar.",
        });
        return;
      }

      const [{ data: pendentes, error: erroPendentes }, { data: regras, error: erroRegras }] = await Promise.all([
        supabase.from("contas_pagar").select("id, fornecedor, valor").eq("status", "pendente").limit(5000),
        supabase.from("xml_regra_fornecedor").select("id, fornecedor_padrao, categoria_id, ativa").eq("ativa", true),
      ]);
      if (erroPendentes || erroRegras) {
        setMensagem({ tipo: "erro", texto: "Erro ao carregar dados pra lançamento: " + (erroPendentes?.message ?? erroRegras?.message ?? "") });
        return;
      }
      const contasPendentes = (pendentes ?? []) as { id: string; fornecedor: string; valor: number }[];
      const regrasAtivas = (regras ?? []) as RegraFornecedor[];
      const categoriaPadraoId = resolverCategoriaPadraoBoletos();

      let criadas = 0;
      let suspeitas = 0;
      let falharam = 0;
      const detalhesFalhas: string[] = [];

      for (const { duplicata, nota } of candidatas) {
        try {
          const candidatosIds = encontrarContasPagarCandidatas(nota.fornecedor_nome ?? "", duplicata.valor, contasPendentes);

          if (candidatosIds.length > 0) {
            const { error } = await supabase
              .from("xml_duplicata")
              .update({ status: "duplicata_suspeita", contas_pagar_candidatas: candidatosIds })
              .eq("id", duplicata.id)
              .eq("status", "candidata");
            if (error) throw new Error(error.message);
            suspeitas++;
            continue;
          }

          const { resultado, erro } = await criarContaPagarDeDuplicata(nota, duplicata, regrasAtivas, "candidata", categoriaPadraoId);
          if (resultado === "criada") {
            criadas++;
          } else {
            falharam++;
            if (resultado === "falhou") {
              detalhesFalhas.push(`${descreverParcela(nota, duplicata)}: ${explicarFalhaLancamento(duplicata, erro)}`);
            }
          }
        } catch (e) {
          falharam++;
          detalhesFalhas.push(`${descreverParcela(nota, duplicata)}: ${e instanceof Error ? e.message : "erro inesperado."}`);
        }
      }

      const partes: string[] = [];
      if (criadas > 0) partes.push(`${criadas} conta(s) a pagar criada(s)`);
      if (suspeitas > 0) partes.push(`${suspeitas} possível(is) duplicata(s) (revisar na tabela)`);
      if (semBoleto > 0) partes.push(`${semBoleto} nota(s) sem boleto no XML (lançar manualmente)`);
      if (falharam > 0) partes.push(`${falharam} erro(s) ao lançar`);

      setErrosLancamento(detalhesFalhas);
      setMensagem({
        tipo: falharam > 0 ? "erro" : "sucesso",
        texto: partes.length > 0 ? partes.join(" · ") : "Nada pendente pra lançar.",
      });
      await carregarNotas();
    } finally {
      setLancando(false);
    }
  }

  async function handleAbrirResolucaoSuspeita(nota: Nota, duplicata: Duplicata) {
    if (!duplicata.contas_pagar_candidatas || duplicata.contas_pagar_candidatas.length === 0) return;
    const { data, error } = await supabase
      .from("contas_pagar")
      .select("id, fornecedor, valor, data_vencimento, status")
      .in("id", duplicata.contas_pagar_candidatas);
    if (error || !data) {
      setMensagem({ tipo: "erro", texto: "Erro ao carregar as contas candidatas: " + (error?.message ?? "") });
      return;
    }
    setResolvendoSuspeita({ duplicata, nota, candidatas: data as { id: string; fornecedor: string; valor: number; data_vencimento: string; status: string }[] });
  }

  function fecharResolucaoSuspeita() {
    if (resolvendoAcao) return;
    setResolvendoSuspeita(null);
  }

  async function handleNaoEDuplicata() {
    if (!resolvendoSuspeita) return;
    setResolvendoAcao(true);
    const { duplicata, nota } = resolvendoSuspeita;
    // Lança direto, sem voltar pra "candidata": o humano já revisou e decidiu,
    // então pular a checagem de candidatas é intencional -- se resetasse pra
    // "candidata", o próximo lote acharia a mesma conta pendente de novo e a
    // marcaria como suspeita antes de qualquer insert (livelock).
    // regrasFornecedor traz ativas e inativas; encontrarCategoriaPorFornecedor
    // já ignora as inativas internamente.
    const { resultado, erro } = await criarContaPagarDeDuplicata(nota, duplicata, regrasFornecedor, "duplicata_suspeita", resolverCategoriaPadraoBoletos());
    setResolvendoAcao(false);
    if (resultado !== "criada") {
      setMensagem({
        tipo: "erro",
        texto:
          resultado === "corrida_perdida"
            ? "Esta parcela já foi resolvida em outra aba. Recarregando a lista."
            : `Erro ao lançar ${descreverParcela(nota, duplicata)}: ${explicarFalhaLancamento(duplicata, erro)}`,
      });
      setResolvendoSuspeita(null);
      await carregarNotas();
      return;
    }
    setResolvendoSuspeita(null);
    await carregarNotas();
    setMensagem({ tipo: "sucesso", texto: "Conta a pagar criada a partir desta parcela do XML." });
  }

  async function handleEDuplicataConfirmada() {
    if (!resolvendoSuspeita) return;
    setResolvendoAcao(true);
    const { duplicata } = resolvendoSuspeita;
    const { error } = await supabase
      .from("xml_duplicata")
      .update({ status: "duplicata_confirmada" })
      .eq("id", duplicata.id)
      .eq("status", "duplicata_suspeita");
    setResolvendoAcao(false);
    if (error) {
      setMensagem({ tipo: "erro", texto: "Erro ao atualizar: " + error.message });
      return;
    }
    setResolvendoSuspeita(null);
    await carregarNotas();
  }

  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-xl font-bold text-[var(--color-text)]">XML de Notas Fiscais</h1>
          <span className="text-[10px] font-semibold px-2 py-1 rounded-full bg-red-50 text-red-700 border border-red-200 whitespace-nowrap">
            ⚠️ Lançar em Contas a Pagar grava em produção
          </span>
        </div>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          Importe os XMLs, confira as parcelas de cada nota e lance em Contas a Pagar. Parcelas parecidas com contas já
          cadastradas são sinalizadas pra revisão antes de virar lançamento.
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
          { id: "notas", label: "📄 Notas" },
          { id: "regras", label: "🔧 Regras" },
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
          <h2 className="font-semibold text-sm mb-1">Importar XML de nota fiscal</h2>
          <p className="text-xs text-[var(--color-text-muted)] mb-4">
            Sem conector de e-mail nesta fase — envie os arquivos .xml (ou .zip com vários XMLs) manualmente, baixados do
            e-mail ou da SEFAZ, exatamente como hoje.
          </p>

          <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Arquivos .xml ou .zip (máx 10 MB cada)</label>
          <input
            ref={inputArquivosRef}
            type="file"
            accept=".xml,.zip"
            multiple
            disabled={!podeEscrever}
            className="w-full text-sm mb-4 file:mr-3 file:px-3 file:py-2 file:rounded-lg file:border-0 file:bg-emerald-50 file:text-emerald-700 file:text-xs file:font-semibold"
          />

          <button
            type="button"
            onClick={handleImportar}
            disabled={!podeEscrever || importando}
            className="w-full px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {importando && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {importando ? "Importando..." : "Importar notas"}
          </button>

          {resumoImportacao && (
            <div className="mt-4 p-3 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-800">
              <p className="font-semibold">
                {resumoImportacao.arquivosLidos} XML(s) lido(s) · {resumoImportacao.notasEncontradas} nota(s) reconhecida(s) · {resumoImportacao.novas} nova(s) · {resumoImportacao.duplicadas} já existente(s)
              </p>
              {resumoImportacao.erros.length > 0 && (
                <ul className="mt-2 list-disc list-inside text-amber-700">
                  {resumoImportacao.erros.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {aba === "notas" && (
        <div>
          {podeEscrever && notas.length > 0 && (
            <div className="mb-4">
              <button
                type="button"
                onClick={handleLancarContasPagar}
                disabled={lancando}
                className="px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2"
              >
                {lancando && <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                {lancando ? "Lançando..." : "Lançar em Contas a Pagar"}
              </button>

              {errosLancamento.length > 0 && (
                <div className="mt-3 p-3 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-800 max-w-2xl">
                  <p className="font-semibold mb-1">Parcelas que não foram lançadas:</p>
                  <ul className="list-disc list-inside space-y-0.5">
                    {errosLancamento.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {carregandoNotas ? (
            <div className="skeleton h-40 rounded-xl" />
          ) : notas.length === 0 ? (
            <EmptyState variant="search" title="Nenhuma nota importada" description="Importe XMLs na aba Importar para começar." compact />
          ) : (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-3 py-2.5 font-semibold">Emissão</th>
                    <th className="px-3 py-2.5 font-semibold">Cadastrado em</th>
                    <th className="px-3 py-2.5 font-semibold">Fornecedor</th>
                    <th className="px-3 py-2.5 font-semibold">Nº nota</th>
                    <th className="px-3 py-2.5 font-semibold text-right">Valor total</th>
                    <th className="px-3 py-2.5 font-semibold">Chave de acesso</th>
                    <th className="px-3 py-2.5 font-semibold">Vencimento(s)</th>
                  </tr>
                </thead>
                <tbody>
                  {notas.map((n) => (
                    <Fragment key={n.id}>
                      <tr className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatarData(n.emitida_em)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{formatarDataCadastro(n.criado_em)}</td>
                        <td className="px-3 py-2.5 max-w-[220px] truncate" title={n.fornecedor_nome ?? ""}>
                          {n.fornecedor_nome ?? "—"}
                          {n.fornecedor_cnpj && <span className="block text-[10px] text-[var(--color-text-muted)]">{n.fornecedor_cnpj}</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">{n.numero_nota ?? "—"}</td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap font-semibold">{formatarMoeda(n.valor_total)}</td>
                        <td className="px-3 py-2.5 font-mono text-[10px]" title={n.chave_acesso}>
                          {formatarChave(n.chave_acesso).slice(0, 24)}…
                        </td>
                        <td className="px-3 py-2.5">
                          {n.xml_duplicata.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setNotaExpandidaId(notaExpandidaId === n.id ? null : n.id)}
                              className="flex flex-wrap gap-1 items-center"
                              title="Ver valor e status de cada parcela"
                            >
                              {[...n.xml_duplicata]
                                .sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? "") || a.id.localeCompare(b.id))
                                .map((d) => (
                                  <span
                                    key={d.id}
                                    className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold whitespace-nowrap"
                                  >
                                    {formatarData(d.vencimento)}
                                  </span>
                                ))}
                              <span className="text-[10px] text-[var(--color-text-muted)]">{notaExpandidaId === n.id ? "▲" : "▼"}</span>
                            </button>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold whitespace-nowrap">
                              sem boleto no XML — lançar manualmente
                            </span>
                          )}
                        </td>
                      </tr>
                      {notaExpandidaId === n.id && n.xml_duplicata.length > 0 && (
                        <tr className="bg-[var(--hover-bg)]">
                          <td colSpan={7} className="px-3 py-2.5">
                            <table className="w-full text-[11px]">
                              <thead>
                                <tr className="text-[var(--color-text-muted)]">
                                  <th className="text-left font-semibold pb-1">Parcela</th>
                                  <th className="text-left font-semibold pb-1">Vencimento</th>
                                  <th className="text-right font-semibold pb-1">Valor</th>
                                  <th className="text-left font-semibold pb-1 pl-3">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[...n.xml_duplicata]
                                  .sort((a, b) => (a.vencimento ?? "").localeCompare(b.vencimento ?? "") || a.id.localeCompare(b.id))
                                  .map((d) => (
                                    <tr key={d.id}>
                                      <td className="py-0.5">{d.numero ?? "—"}</td>
                                      <td className="py-0.5">{formatarData(d.vencimento)}</td>
                                      <td className="py-0.5 text-right">{formatarMoeda(d.valor)}</td>
                                      <td className="py-0.5 pl-3">
                                        {d.status === "lancada" && d.conta_pagar_id === null ? (
                                          <span
                                            className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200 text-[10px]"
                                            title="A conta a pagar vinculada foi excluída depois"
                                          >
                                            lançada — conta excluída
                                          </span>
                                        ) : d.status === "lancada" ? (
                                          <span className="px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px]">lançada</span>
                                        ) : d.status === "duplicata_suspeita" ? (
                                          <button
                                            type="button"
                                            onClick={() => handleAbrirResolucaoSuspeita(n, d)}
                                            className="px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold"
                                          >
                                            possível duplicata — revisar
                                          </button>
                                        ) : d.status === "duplicata_confirmada" ? (
                                          <span className="px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 border border-gray-200 text-[10px]">duplicata (não lançada)</span>
                                        ) : (
                                          <span className="px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 text-[10px]">pendente de lançar</span>
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {aba === "regras" && (
        <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-x-auto">
            {carregandoRegras ? (
              <div className="skeleton h-40 rounded-xl m-4" />
            ) : regrasFornecedor.length === 0 ? (
              <EmptyState variant="search" title="Nenhuma regra cadastrada" description="Crie uma regra pra categorizar automaticamente." compact />
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-left text-[var(--color-text-muted)]">
                    <th className="px-3 py-2.5 font-semibold">Fornecedor padrão</th>
                    <th className="px-3 py-2.5 font-semibold">Categoria</th>
                    <th className="px-3 py-2.5 font-semibold text-center">Ativa</th>
                    <th className="px-3 py-2.5 font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {regrasFornecedor.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0 hover:bg-[var(--hover-bg)]">
                      <td className="px-3 py-2.5">{r.fornecedor_padrao}</td>
                      <td className="px-3 py-2.5">{categoriasSaida.find((c) => c.id === r.categoria_id)?.nome ?? "—"}</td>
                      <td className="px-3 py-2.5 text-center">
                        <button
                          type="button"
                          disabled={!podeEscrever}
                          onClick={() => handleAlternarAtivaRegra(r)}
                          className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border disabled:opacity-50 ${
                            r.ativa ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-gray-100 text-gray-500 border-gray-200"
                          }`}
                        >
                          {r.ativa ? "Ativa" : "Inativa"}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        {podeEscrever && (
                          <>
                            <button type="button" onClick={() => iniciarEdicaoRegra(r)} className="text-blue-600 hover:underline text-[11px] font-medium mr-2">
                              Editar
                            </button>
                            <button type="button" onClick={() => handleExcluirRegraFornecedor(r)} className="text-red-500 hover:underline text-[11px] font-medium">
                              Excluir
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {podeEscrever && (
            <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 h-fit">
              <h3 className="font-semibold text-sm mb-3">{editandoRegraId ? "Editar regra" : "Nova regra"}</h3>

              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Fornecedor padrão</label>
              <input
                type="text"
                value={formRegraFornecedor.fornecedor_padrao}
                onChange={(e) => setFormRegraFornecedor((f) => ({ ...f, fornecedor_padrao: e.target.value }))}
                placeholder="Ex.: Severini"
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-3"
              />

              <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label>
              <select
                value={formRegraFornecedor.categoria_id}
                onChange={(e) => setFormRegraFornecedor((f) => ({ ...f, categoria_id: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm mb-4"
              >
                <option value="">selecione...</option>
                {categoriasSaida.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nome}
                  </option>
                ))}
              </select>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSalvarRegraFornecedor}
                  disabled={salvandoRegra}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
                >
                  {salvandoRegra ? "Salvando..." : editandoRegraId ? "Salvar edição" : "Criar regra"}
                </button>
                {editandoRegraId && (
                  <button type="button" onClick={iniciarNovaRegra} className="px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-semibold">
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {resolvendoSuspeita && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => fecharResolucaoSuspeita()}>
          <div className="bg-[var(--color-surface)] rounded-2xl p-6 max-w-lg w-full" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-semibold text-sm mb-1">Possível duplicata</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              Já existe conta a pagar pendente parecida com esta parcela do XML. É a mesma conta, ou são coisas diferentes?
            </p>

            <div className="mb-3 p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
              <p className="font-semibold mb-1">Do XML:</p>
              <p>{resolvendoSuspeita.nota.fornecedor_nome ?? "—"} · {formatarMoeda(resolvendoSuspeita.duplicata.valor)} · vence {formatarData(resolvendoSuspeita.duplicata.vencimento)}</p>
            </div>

            <div className="mb-4 space-y-2">
              <p className="text-xs font-semibold">Já cadastrado(s):</p>
              {resolvendoSuspeita.candidatas.map((c) => (
                <div key={c.id} className="p-3 rounded-xl bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
                  {c.fornecedor} · {formatarMoeda(c.valor)} · vence {formatarData(c.data_vencimento)} · {c.status}
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleEDuplicataConfirmada}
                disabled={resolvendoAcao}
                className="flex-1 px-4 py-2.5 rounded-xl border border-[var(--color-border)] text-sm font-semibold disabled:opacity-50"
              >
                É duplicata — não lançar
              </button>
              <button
                type="button"
                onClick={handleNaoEDuplicata}
                disabled={resolvendoAcao}
                className="flex-1 px-4 py-2.5 rounded-xl bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
              >
                Não é — lançar mesmo assim
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
