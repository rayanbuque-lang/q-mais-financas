"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { registrarLog } from "@/lib/audit";

interface Categoria { id: string; nome: string; }

interface Movimentacao {
  id: string;
  tipo: string;
  data: string;
  valor: number;
  categoria_id: string;
  observacao: string;
  revisar: boolean;
  categoria_nome: string;
}

interface SubItem {
  descricao: string;
  valor: number;
}

const meses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const categoriasComUpload = ["Cartão", "Pix Inter", "Pix Santander"];

export default function MovimentacoesPage() {
  const [tipo, setTipo] = useState<"entrada"|"saida">("entrada");
  const [data, setData] = useState(new Date().toISOString().split("T")[0]);
  const [valor, setValor] = useState("");
  const [categoriaId, setCategoriaId] = useState("");
  const [observacao, setObservacao] = useState("");
  const [revisar, setRevisar] = useState(false);
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [todasEntradas, setTodasEntradas] = useState<Categoria[]>([]);
  const [todasSaidas, setTodasSaidas] = useState<Categoria[]>([]);
  const [movimentacoes, setMovimentacoes] = useState<Movimentacao[]>([]);
  const [itensPorMov, setItensPorMov] = useState<Record<string, SubItem[]>>({});
  const [movExpandida, setMovExpandida] = useState<string|null>(null);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [mensagem, setMensagem] = useState("");
  const [editandoId, setEditandoId] = useState<string|null>(null);
  const [mes, setMes] = useState(new Date().getMonth());
  const [ano, setAno] = useState(new Date().getFullYear());
  const [aba, setAba] = useState<"lancamentos"|"resumo">("lancamentos");
  const [filtroTipo, setFiltroTipo] = useState<"todos"|"entrada"|"saida">("todos");
  const [filtroCategoria, setFiltroCategoria] = useState("todas");
  const [busca, setBusca] = useState("");
  const [filtroRevisar, setFiltroRevisar] = useState(false);
  const [temSubItens, setTemSubItens] = useState(false);
  const [subDescricao, setSubDescricao] = useState("");
  const [subValoresTexto, setSubValoresTexto] = useState("");
  const [subItensParseados, setSubItensParseados] = useState<SubItem[]>([]);
  const [uploadando, setUploadando] = useState(false);
  const supabase = createClient();

  const categoriaSelecionada = categorias.find(c => c.id === categoriaId);
  const podeUpload = tipo === "entrada" && categoriaSelecionada && categoriasComUpload.some(nome => categoriaSelecionada.nome.includes(nome));

  async function carregarCategorias() {
    const tabela = tipo === "entrada" ? "categorias_entrada" : "categorias_saida";
    const { data } = await supabase.from(tabela).select("*").eq("ativo", true).order("nome");
    if (data) { setCategorias(data); if (data.length > 0) setCategoriaId(data[0].id); }
  }

  async function carregarTodasCategorias() {
    const [r1,r2] = await Promise.all([
      supabase.from("categorias_entrada").select("*").eq("ativo",true).order("nome"),
      supabase.from("categorias_saida").select("*").eq("ativo",true).order("nome"),
    ]);
    if (r1.data) setTodasEntradas(r1.data);
    if (r2.data) setTodasSaidas(r2.data);
  }

  async function carregarMovimentacoes() {
    const inicio = `${ano}-${String(mes+1).padStart(2,"0")}-01`;
    const ultimoDia = new Date(ano,mes+1,0).getDate();
    const fim = `${ano}-${String(mes+1).padStart(2,"0")}-${String(ultimoDia).padStart(2,"0")}`;
    const { data } = await supabase.from("movimentacoes").select("*").gte("data",inicio).lte("data",fim).order("data",{ascending:false});
    if (data) {
      const lista = await Promise.all(data.map(async(mov)=>{
        const tabela = mov.tipo==="entrada"?"categorias_entrada":"categorias_saida";
        const { data:cat } = await supabase.from(tabela).select("nome").eq("id",mov.categoria_id).single();
        return { ...mov, categoria_nome: cat?.nome||"Sem categoria" };
      }));
      setMovimentacoes(lista);
      const ids = data.map(m=>m.id);
      if (ids.length > 0) {
        const { data:subItens} = await supabase.from("movimentacao_itens").select("*").in("movimentacao_id",ids);
        if (subItens) {
          const agrupados: Record<string, SubItem[]> = {};
          subItens.forEach(item=>{
            if (!agrupados[item.movimentacao_id]) agrupados[item.movimentacao_id]=[];
            agrupados[item.movimentacao_id].push({descricao:item.descricao,valor:item.valor});
          });
          setItensPorMov(agrupados);
        }
      }
    }
  }

  useEffect(()=>{carregarCategorias();},[tipo]);
  useEffect(()=>{carregarMovimentacoes();carregarTodasCategorias();},[mes,ano]);

  // ===== UPLOAD =====
  function parsearValorMonetario(str: string): number {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");
    let numStr: string;
    if (lastComma > lastDot) {
      numStr = str.replace(/\./g, "").replace(",", ".");
    } else {
      numStr = str.replace(/,/g, "");
    }
    return parseFloat(numStr);
  }

  function parsearCSV(conteudo: string): SubItem[] {
    const linhas = conteudo.split(/\r?\n/).filter(l => l.trim().length > 0);
    const itens: SubItem[] = [];

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      const colunas = linha.split(/[;,\t|]/);
      let valorEncontrado: number | null = null;
      let descricaoEncontrada = "";

      for (const col of colunas) {
        const colTrim = col.trim();
        const valorMatch = colTrim.match(/[-]?(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/);
        if (valorMatch) {
          const num = parsearValorMonetario(valorMatch[0]);
          if (!isNaN(num) && num > 0) {
            valorEncontrado = num;
          }
        } else if (colTrim.length > 2 && !colTrim.match(/^[\d.,\-]+$/) && !descricaoEncontrada) {
          descricaoEncontrada = colTrim;
        }
      }

      if (valorEncontrado !== null) {
        itens.push({
          descricao: descricaoEncontrada || `Item ${itens.length + 1}`,
          valor: valorEncontrado,
        });
      }
    }
    return itens;
  }

  async function processarUpload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadando(true);
    setMensagem("");

    try {
      if (file.name.toLowerCase().endsWith(".csv")) {
        const conteudo = await file.text();
        const itens = parsearCSV(conteudo);

        if (itens.length > 0) {
          setTemSubItens(true);
          setSubDescricao(categoriaSelecionada?.nome || "Upload");
          setSubValoresTexto(itens.map(i => i.valor.toFixed(2).replace(".", ",")).join(" + "));
          setSubItensParseados(itens);
          setMensagem(`${itens.length} valores extraídos do arquivo!`);
        } else {
          setMensagem("Nenhum valor encontrado. Verifique o formato do arquivo.");
        }
      } else if (file.name.toLowerCase().endsWith(".pdf")) {
        setMensagem("Envie o arquivo PDF para que eu configure a extração. Por enquanto, use CSV.");
      } else {
        setMensagem("Formato não suportado. Use .csv ou .pdf");
      }
    } catch {
      setMensagem("Erro ao ler arquivo.");
    }

    setUploadando(false);
    event.target.value = "";
    setTimeout(() => setMensagem(""), 5000);
  }

  // ===== SUB-ITENS =====
  function parsearValores(texto: string): number[] {
    if (!texto.trim()) return [];
    return texto.split(/[+\n;|]/).map(v => v.trim().replace(",", ".")).filter(v => v !== "" && !isNaN(parseFloat(v))).map(v => parseFloat(v));
  }

  useEffect(() => {
    const valores = parsearValores(subValoresTexto);
    const itens: SubItem[] = valores.map((v, i) => ({
      descricao: subDescricao ? `${subDescricao} #${i + 1}` : `Item ${i + 1}`,
      valor: v,
    }));
    setSubItensParseados(itens);
    if (temSubItens && valores.length > 0) {
      setValor(valores.reduce((a, v) => a + v, 0).toFixed(2).replace(".", ","));
    }
  }, [subValoresTexto, subDescricao, temSubItens]);

  const subTotal = parsearValores(subValoresTexto).reduce((a, v) => a + v, 0);

  // ===== FORM =====
  function resetarFormulario() {
    setTipo("entrada"); setData(new Date().toISOString().split("T")[0]); setValor(""); setCategoriaId(""); setObservacao(""); setRevisar(false); setEditandoId(null);
    setTemSubItens(false); setSubDescricao(""); setSubValoresTexto(""); setSubItensParseados([]);
  }

  function abrirFormularioNovo() { resetarFormulario(); setShowForm(true); }

  function abrirFormularioEditar(mov: Movimentacao) {
    setTipo(mov.tipo as "entrada"|"saida"); setData(mov.data); setValor(mov.valor.toString().replace(".",",")); setObservacao(mov.observacao||""); setRevisar(mov.revisar||false); setEditandoId(mov.id); setShowForm(true);
    const subItens = itensPorMov[mov.id];
    if (subItens && subItens.length > 0) {
      setTemSubItens(true);
      setSubDescricao(subItens[0].descricao.replace(/ #\d+$/, ""));
      setSubValoresTexto(subItens.map(si => si.valor.toFixed(2).replace(".", ",")).join(" + "));
      setSubItensParseados(subItens);
    } else {
      setTemSubItens(false); setSubDescricao(""); setSubValoresTexto(""); setSubItensParseados([]);
    }
    setTimeout(async()=>{
      const tabela = mov.tipo==="entrada"?"categorias_entrada":"categorias_saida";
      const {data:cats} = await supabase.from(tabela).select("*").eq("ativo",true).order("nome");
      if(cats){setCategorias(cats);setCategoriaId(mov.categoria_id);}
    },100);
    window.scrollTo({top:0,behavior:"smooth"});
  }

  async function handleSalvar(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setMensagem("");
    const dados = {tipo,data,valor:parseFloat(valor.replace(",",".")),categoria_id:categoriaId,observacao,revisar};
    let movId = editandoId;
    let error;
    if (editandoId) {
      const r = await supabase.from("movimentacoes").update(dados).eq("id",editandoId); error = r.error;
    } else {
      const r = await supabase.from("movimentacoes").insert(dados).select("id").single(); error = r.error;
      if (r.data) movId = r.data.id;
    }
    if (!error && movId && temSubItens && subItensParseados.length > 0) {
      await supabase.from("movimentacao_itens").delete().eq("movimentacao_id",movId);
      await supabase.from("movimentacao_itens").insert(subItensParseados.map(i=>({movimentacao_id:movId,descricao:i.descricao,valor:i.valor})));
    } else if (!error && movId && !temSubItens) {
      await supabase.from("movimentacao_itens").delete().eq("movimentacao_id",movId);
    }
    if (error) { setMensagem("Erro ao salvar."); }
    else {
      const nomeLog = `${tipo === "entrada" ? "Entrada" : "Saída"} de R$ ${parseFloat(valor.replace(",",".")).toFixed(2)}`;
      await registrarLog({
        acao: editandoId ? "editou" : "criou",
        tabela: "movimentacoes",
        registroId: movId || undefined,
        dadosNovos: dados,
        detalhes: nomeLog,
      });
      setMensagem(editandoId?"Atualizado!":"Salvo!"); resetarFormulario(); setShowForm(false); carregarMovimentacoes();
    }
    setLoading(false); setTimeout(()=>setMensagem(""),3000);
  }

  async function handleExcluir(id:string) {
    if (!confirm("Excluir?")) return;
    await registrarLog({ acao: "excluiu", tabela: "movimentacoes", registroId: id, detalhes: "Excluiu movimentação" });
    await supabase.from("movimentacoes").delete().eq("id",id);
    setMensagem("Excluída!"); carregarMovimentacoes(); setTimeout(()=>setMensagem(""),3000);
  }

  async function toggleRevisar(mov:Movimentacao) {
    await supabase.from("movimentacoes").update({revisar:!mov.revisar}).eq("id",mov.id); carregarMovimentacoes();
  }

  function toggleExpandir(id:string) { setMovExpandida(movExpandida===id?null:id); }
  function fmt(v:number){return v.toLocaleString("pt-BR",{style:"currency",currency:"BRL"});}
  function mesAnterior(){if(mes===0){setMes(11);setAno(ano-1);}else setMes(mes-1);}
  function mesProximo(){if(mes===11){setMes(0);setAno(ano+1);}else setMes(mes+1);}

  const movFiltradas = movimentacoes.filter(m=>{
    if(filtroTipo!=="todos"&&m.tipo!==filtroTipo)return false;
    if(filtroCategoria!=="todas"&&m.categoria_id!==filtroCategoria)return false;
    if(filtroRevisar&&!m.revisar)return false;
    if(busca){const b=busca.toLowerCase();if(!m.observacao?.toLowerCase().includes(b)&&!m.categoria_nome.toLowerCase().includes(b))return false;}
    return true;
  });

  const entradas = movFiltradas.filter(m=>m.tipo==="entrada").sort((a,b)=>a.categoria_nome.localeCompare(b.categoria_nome));
  const saidas = movFiltradas.filter(m=>m.tipo==="saida").sort((a,b)=>a.categoria_nome.localeCompare(b.categoria_nome));
  const totalEntradas = movimentacoes.filter(m=>m.tipo==="entrada").reduce((a,m)=>a+m.valor,0);
  const totalSaidas = movimentacoes.filter(m=>m.tipo==="saida").reduce((a,m)=>a+m.valor,0);
  const totalRevisar = movimentacoes.filter(m=>m.revisar).length;

  function agruparPorCategoria(lista:Movimentacao[]){
    const grupos:{nome:string;total:number;quantidade:number}[]=[];
    lista.forEach(m=>{const e=grupos.find(g=>g.nome===m.categoria_nome);if(e){e.total+=m.valor;e.quantidade++;}else grupos.push({nome:m.categoria_nome,total:m.valor,quantidade:1});});
    return grupos.sort((a,b)=>a.nome.localeCompare(b.nome));
  }
  const resumoEntradas = agruparPorCategoria(movimentacoes.filter(m=>m.tipo==="entrada"));
  const resumoSaidas = agruparPorCategoria(movimentacoes.filter(m=>m.tipo==="saida"));
  function pct(v:number,t:number){return t===0?0:(v/t)*100;}
  const todasCategoriasFiltro = filtroTipo==="entrada"?todasEntradas:filtroTipo==="saida"?todasSaidas:[...todasEntradas,...todasSaidas];

  function renderMovimentacao(mov:Movimentacao) {
    const temItens = itensPorMov[mov.id] && itensPorMov[mov.id].length > 0;
    const expandida = movExpandida === mov.id;
    return (
      <div key={mov.id}>
        <div className={`flex items-center justify-between p-4 hover:bg-[var(--color-bg)] transition-colors ${temItens?"cursor-pointer":""}`}>
          <div className="flex items-center gap-3 min-w-0" onClick={temItens?()=>toggleExpandir(mov.id):undefined}>
            <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-sm shrink-0 ${mov.tipo==="entrada"?"bg-emerald-50 text-emerald-600":"bg-red-50 text-red-500"}`}>
              {temItens?(expandida?"▼":"▶"):(mov.tipo==="entrada"?"▲":"▼")}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold truncate">{mov.categoria_nome}</p>
                {mov.revisar&&<span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[10px] font-bold shrink-0">REVISAR</span>}
                {temItens&&<span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold shrink-0">{itensPorMov[mov.id].length} itens</span>}
              </div>
              <p className="text-xs text-[var(--color-text-muted)]">{new Date(mov.data+"T12:00:00").toLocaleDateString("pt-BR")}{mov.observacao&&` · ${mov.observacao}`}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className={`font-bold text-sm ${mov.tipo==="entrada"?"text-emerald-600":"text-red-500"}`}>{mov.tipo==="entrada"?"+":"-"} {fmt(mov.valor)}</span>
            <button onClick={()=>toggleRevisar(mov)} title={mov.revisar?"Remover":"Marcar"} className={`p-1.5 rounded-lg transition text-sm ${mov.revisar?"bg-amber-100 text-amber-600":"hover:bg-gray-100 text-gray-300"}`}>⚠️</button>
            <button onClick={()=>abrirFormularioEditar(mov)} title="Editar" className="p-1.5 rounded-lg hover:bg-emerald-50 text-[var(--color-text-muted)] hover:text-emerald-600 transition text-sm">✏️</button>
            <button onClick={()=>handleExcluir(mov.id)} title="Excluir" className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
          </div>
        </div>
        {temItens && expandida && (
          <div className="bg-[var(--color-bg)] border-t border-[var(--color-border)] px-4 py-3 ml-16 mr-4 mb-2 rounded-xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">Valores individuais:</p>
            <div className="space-y-1.5">
              {itensPorMov[mov.id].map((item,i)=>(
                <div key={i} className="flex justify-between items-center text-sm">
                  <span className="text-[var(--color-text)]">{item.descricao}</span>
                  <span className={`font-medium ${mov.tipo==="entrada"?"text-emerald-600":"text-red-500"}`}>{fmt(item.valor)}</span>
                </div>
              ))}
            </div>
            <div className="border-t border-[var(--color-border)] mt-2 pt-2 flex justify-between items-center text-sm">
              <span className="font-bold">Total</span>
              <span className={`font-bold ${mov.tipo==="entrada"?"text-emerald-600":"text-red-500"}`}>{fmt(mov.valor)}</span>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div><h1 className="text-2xl font-bold tracking-tight">Movimentações</h1><p className="text-[var(--color-text-muted)] text-sm mt-1">Registre entradas e saídas</p></div>
        <button onClick={abrirFormularioNovo} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">+ Nova Movimentação</button>
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold capitalize">{meses[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[{l:"Entradas",v:fmt(totalEntradas),c:"text-emerald-600"},{l:"Saídas",v:fmt(totalSaidas),c:"text-red-500"},{l:"Saldo",v:fmt(totalEntradas-totalSaidas),c:totalEntradas-totalSaidas>=0?"text-emerald-600":"text-red-500"},{l:"Revisão",v:`${totalRevisar}`,c:totalRevisar>0?"text-amber-600":"text-[var(--color-text-muted)]"}].map(c=>(
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-3 text-center"><p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p><p className={`font-bold ${c.c}`}>{c.v}</p></div>
        ))}
      </div>

      {mensagem&&<div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro")?"bg-red-50 text-red-600":"bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {showForm&&(
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6 shadow-sm">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId?"Editar":"Nova"} Movimentação</h2>
            <button onClick={()=>{setShowForm(false);resetarFormulario();}} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>

          <form onSubmit={handleSalvar} className="space-y-4">
            <div className="flex gap-3">
              <button type="button" onClick={()=>{setTipo("entrada");setCategoriaId("");}} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo==="entrada"?"bg-emerald-600 text-white shadow-md shadow-emerald-200":"bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▲ Entrada</button>
              <button type="button" onClick={()=>{setTipo("saida");setCategoriaId("");}} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo==="saida"?"bg-red-500 text-white shadow-md shadow-red-200":"bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▼ Saída</button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Data</label><input type="date" value={data} onChange={e=>setData(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"/></div>
              <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valor Total (R$)</label><input type="text" value={valor} onChange={e=>setValor(e.target.value)} placeholder="0,00" required readOnly={temSubItens&&subItensParseados.length>0} className={`w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none ${temSubItens&&subItensParseados.length>0?"opacity-60":""}`}/></div>
            </div>

            <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Categoria</label><select value={categoriaId} onChange={e=>setCategoriaId(e.target.value)} required className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none">{categorias.map(cat=>(<option key={cat.id} value={cat.id}>{cat.nome}</option>))}</select></div>
            <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Observação</label><input type="text" value={observacao} onChange={e=>setObservacao(e.target.value)} placeholder="Descrição opcional" className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"/></div>

            <button type="button" onClick={()=>setRevisar(!revisar)} className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-sm font-medium transition-all w-full ${revisar?"bg-amber-50 border-amber-300 text-amber-800":"bg-[var(--color-bg)] border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
              <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${revisar?"bg-amber-500 border-amber-500":"border-gray-300"}`}>{revisar&&<span className="text-white text-xs">✓</span>}</div>
              ⚠️ Marcar para revisar
            </button>

            {/* Upload de extrato */}
            {podeUpload && (
              <div className="border-2 border-dashed border-blue-300 rounded-xl p-5 text-center bg-blue-50/30">
                <p className="text-lg mb-1">📤</p>
                <p className="text-sm font-semibold text-blue-700 mb-1">Upload de extrato - {categoriaSelecionada?.nome}</p>
                <p className="text-xs text-blue-500 mb-3">Envie o arquivo CSV do dia e os valores serão extraídos automaticamente</p>
                <label className={`inline-flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold cursor-pointer hover:bg-blue-700 transition ${uploadando?"opacity-60 pointer-events-none":""}`}>
                  {uploadando ? (
                    <><span className="animate-spin">⏳</span> Processando...</>
                  ) : (
                    <><span>📁</span> Selecionar arquivo CSV</>
                  )}
                  <input type="file" accept=".csv" onChange={processarUpload} className="hidden" disabled={uploadando} />
                </label>
              </div>
            )}

            {/* Sub-itens */}
            <div className="border border-[var(--color-border)] rounded-xl p-4 bg-[var(--color-bg)]">
              <button type="button" onClick={()=>setTemSubItens(!temSubItens)} className={`flex items-center gap-2 text-sm font-medium transition ${temSubItens?"text-blue-700":"text-[var(--color-text-muted)]"} w-full`}>
                <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${temSubItens?"bg-blue-500 border-blue-500":"border-gray-300"}`}>{temSubItens&&<span className="text-white text-xs">✓</span>}</div>
                📋 Valores individuais (soma de vários valores)
              </button>

              {temSubItens && (
                <div className="space-y-4 mt-4">
                  <p className="text-xs text-[var(--color-text-muted)]">Digite os valores separados por <strong>+</strong> e o sistema soma automaticamente.</p>
                  <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Descrição</label><input type="text" value={subDescricao} onChange={e=>setSubDescricao(e.target.value)} placeholder="Ex: Pix recebido, Cartão, etc." className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm focus:outline-none"/></div>
                  <div><label className="block text-sm font-semibold mb-2 text-[var(--color-text-muted)]">Valores</label><textarea value={subValoresTexto} onChange={e=>setSubValoresTexto(e.target.value)} placeholder="Ex: 13,50 + 2,50 + 120,98 + 13,10" rows={3} className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-sm focus:outline-none resize-none font-mono"/></div>

                  {subItensParseados.length > 0 && (
                    <div className="bg-[var(--color-surface)] rounded-xl border border-blue-200 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wider text-blue-600 mb-2">Preview ({subItensParseados.length} valores)</p>
                      <div className="space-y-1.5">
                        {subItensParseados.map((item,i)=>(
                          <div key={i} className="flex justify-between items-center text-sm">
                            <span className="text-[var(--color-text-muted)]">{item.descricao}</span>
                            <span className="font-medium">{fmt(item.valor)}</span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-blue-200 mt-3 pt-3 flex justify-between items-center">
                        <span className="font-bold text-sm">Total</span>
                        <span className="font-bold text-lg text-blue-700">{fmt(subTotal)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <button type="button" onClick={()=>{setShowForm(false);resetarFormulario();}} className="flex-1 py-3 bg-[var(--color-bg)] text-[var(--color-text-muted)] font-semibold rounded-xl border border-[var(--color-border)] hover:bg-gray-100 transition text-sm">Cancelar</button>
              <button type="submit" disabled={loading} className="flex-1 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">{loading?"Salvando...":editandoId?"Atualizar":"Salvar"}</button>
            </div>
          </form>
        </div>
      )}

      {/* Filtros */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Filtros:</span>
          {(["todos","entrada","saida"] as const).map(v=>(
            <button key={v} onClick={()=>{setFiltroTipo(v);setFiltroCategoria("todas");}} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filtroTipo===v?"bg-emerald-600 text-white":"bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>{v==="todos"?"Todos":v==="entrada"?"Entradas":"Saídas"}</button>
          ))}
          <button onClick={()=>setFiltroRevisar(!filtroRevisar)} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${filtroRevisar?"bg-amber-500 text-white":"bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>⚠️ Revisão</button>
        </div>
        <div className="flex gap-3">
          <select value={filtroCategoria} onChange={e=>setFiltroCategoria(e.target.value)} className="flex-1 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"><option value="todas">Todas categorias</option>{todasCategoriasFiltro.map(cat=>(<option key={cat.id} value={cat.id}>{cat.nome}</option>))}</select>
          <input type="text" value={busca} onChange={e=>setBusca(e.target.value)} placeholder="Buscar..." className="flex-1 px-3 py-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-sm focus:outline-none"/>
        </div>
      </div>

      <div className="flex gap-1 bg-[var(--color-bg)] rounded-xl p-1">
        <button onClick={()=>setAba("lancamentos")} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${aba==="lancamentos"?"bg-[var(--color-surface)] shadow-sm":"text-[var(--color-text-muted)]"}`}>Lançamentos</button>
        <button onClick={()=>setAba("resumo")} className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${aba==="resumo"?"bg-[var(--color-surface)] shadow-sm":"text-[var(--color-text-muted)]"}`}>Resumo por Categoria</button>
      </div>

      {aba==="lancamentos"&&(
        <div className="space-y-4">
          {movFiltradas.length===0?(<div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Nenhuma movimentação encontrada.</div>):(
            <>
              {entradas.length>0&&(
                <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                  <div className="p-4 border-b border-[var(--color-border)] bg-emerald-50 flex items-center justify-between"><h3 className="font-bold text-emerald-800 text-sm">▲ ENTRADAS</h3><span className="text-sm font-bold text-emerald-700">{fmt(entradas.reduce((a,m)=>a+m.valor,0))}</span></div>
                  <div className="divide-y divide-[var(--color-border)]">{entradas.map(m=>renderMovimentacao(m))}</div>
                </div>
              )}
              {saidas.length>0&&(
                <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                  <div className="p-4 border-b border-[var(--color-border)] bg-red-50 flex items-center justify-between"><h3 className="font-bold text-red-700 text-sm">▼ SAÍDAS</h3><span className="text-sm font-bold text-red-500">{fmt(saidas.reduce((a,m)=>a+m.valor,0))}</span></div>
                  <div className="divide-y divide-[var(--color-border)]">{saidas.map(m=>renderMovimentacao(m))}</div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {aba==="resumo"&&(
        <div className="space-y-4">
          {[{title:"Entradas por Categoria",data:resumoEntradas,total:totalEntradas,color:"emerald"},{title:"Saídas por Categoria",data:resumoSaidas,total:totalSaidas,color:"red"}].map(section=>(
            <div key={section.title} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
              <div className={`p-4 border-b border-[var(--color-border)] ${section.color==="emerald"?"bg-emerald-50":"bg-red-50"}`}>
                <div className="flex items-center justify-between"><h2 className={`font-bold ${section.color==="emerald"?"text-emerald-800":"text-red-700"}`}>{section.title}</h2><span className={`text-sm font-bold ${section.color==="emerald"?"text-emerald-700":"text-red-500"}`}>{fmt(section.total)}</span></div>
              </div>
              {section.data.length===0?<div className="p-8 text-center text-sm text-[var(--color-text-muted)]">Nenhum dado</div>:(
                <div className="divide-y divide-[var(--color-border)]">
                  {section.data.map(cat=>(
                    <div key={cat.nome} className="p-4">
                      <div className="flex items-center justify-between mb-2"><span className="text-sm font-semibold">{cat.nome} <span className="text-xs text-[var(--color-text-muted)] font-normal">{cat.quantidade}x</span></span><div className="text-right"><span className={`text-sm font-bold ${section.color==="emerald"?"text-emerald-600":"text-red-500"}`}>{fmt(cat.total)}</span><span className="text-xs text-[var(--color-text-muted)] ml-2">{pct(cat.total,section.total).toFixed(1)}%</span></div></div>
                      <div className={`w-full h-2 ${section.color==="emerald"?"bg-emerald-100":"bg-red-100"} rounded-full overflow-hidden`}><div className={`h-full ${section.color==="emerald"?"bg-emerald-500":"bg-red-500"} rounded-full transition-all duration-500`} style={{width:`${pct(cat.total,section.total)}%`}}/></div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
