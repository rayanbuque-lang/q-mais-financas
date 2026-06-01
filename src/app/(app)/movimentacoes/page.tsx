"use client";
import {useEffect,useState} from "react";
import {createClient} from "@/lib/supabase/client";
import {registrarLog} from "@/lib/audit";

interface Movimentacao{id:string;tipo:string;data:string;valor:number;categoria_id:string;observacao:string;revisar:boolean;forma_pagamento:string|null;}
interface Cat{id:string;nome:string;}
const mesesNomes=["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

export default function MovimentacoesPage(){
  const[movs,setMovs]=useState<Movimentacao[]>([]);
  const[catEntrada,setCatEntrada]=useState<Cat[]>([]);
  const[catSaida,setCatSaida]=useState<Cat[]>([]);
  const[mes,setMes]=useState(new Date().getMonth());
  const[ano,setAno]=useState(new Date().getFullYear());
  const[loading,setLoading]=useState(false);
  const[mensagem,setMensagem]=useState("");
  const[showForm,setShowForm]=useState(false);

  const[tipo,setTipo]=useState<"entrada"|"saida">("saida");
  const[data,setData]=useState("");
  const[valor,setValor]=useState("");
  const[categoriaId,setCategoriaId]=useState("");
  const[observacao,setObservacao]=useState("");
  const[formaPagamento,setFormaPagamento]=useState("");
  const[editandoId,setEditandoId]=useState<string|null>(null);

  const supabase=createClient();
  const cats=tipo==="entrada"?catEntrada:catSaida;

  async function carregarTodasCategorias(){
    const[r1,r2]=await Promise.all([
      supabase.from("categorias_entrada").select("id,nome").eq("ativo",true).order("nome"),
      supabase.from("categorias_saida").select("id,nome").eq("ativo",true).order("nome"),
    ]);
    if(r1.data)setCatEntrada(r1.data);
    if(r2.data)setCatSaida(r2.data);
  }

  async function carregarMovimentacoes(){
    const inicio=`${ano}-${String(mes+1).padStart(2,"0")}-01`;
    const ultimoDia=new Date(ano,mes+1,0).getDate();
    const fim=`${ano}-${String(mes+1).padStart(2,"0")}-${String(ultimoDia).padStart(2,"0")}`;
    const{data}=await supabase.from("movimentacoes").select("*").gte("data",inicio).lte("data",fim).order("data",{ascending:false});
    if(data)setMovs(data as Movimentacao[]);
  }

  useEffect(()=>{carregarMovimentacoes();carregarTodasCategorias();},[mes,ano]);

  useEffect(()=>{
    const cats=tipo==="entrada"?catEntrada:catSaida;
    if(cats.length>0&&!cats.find(c=>c.id===categoriaId))setCategoriaId(cats[0].id);
  },[tipo,catEntrada,catSaida]);

  function resetForm(){setTipo("saida");setData("");setValor("");setCategoriaId("");setObservacao("");setFormaPagamento("");setEditandoId(null);}

  function novoLancamento(){
    resetForm();
    const cats=tipo==="saida"?catSaida:catEntrada;
    if(cats.length>0)setCategoriaId(cats[0].id);
    setShowForm(true);
    window.scrollTo({top:0,behavior:"smooth"});
  }

  function editarMov(m:Movimentacao){
    setTipo(m.tipo);setData(m.data);setValor(m.valor.toString().replace(".",","));
    setCategoriaId(m.categoria_id);setObservacao(m.observacao||"");
    setFormaPagamento(m.forma_pagamento||"");
    setEditandoId(m.id);setShowForm(true);
    window.scrollTo({top:0,behavior:"smooth"});
  }

  async function handleSubmit(e:React.FormEvent){
    e.preventDefault();setLoading(true);setMensagem("");
    const dados={
      tipo,data,valor:parseFloat(valor.replace(",",".")),
      categoria_id:categoriaId,observacao,
      forma_pagamento:tipo==="entrada"&&formaPagamento?formaPagamento:null,
      revisar:false
    };
    let error;
    if(editandoId){
      const{data:ant}=await supabase.from("movimentacoes").select("*").eq("id",editandoId).single();
      const r=await supabase.from("movimentacoes").update(dados).eq("id",editandoId);
      error=r.error;
      if(!error)await registrarLog({acao:"editou",tabela:"movimentacoes",registroId:editandoId,dadosAnteriores:ant,dadosNovos:dados,detalhes:`${tipo==="entrada"?"+":"-"} R$ ${dados.valor.toFixed(2)}`});
    }else{
      const r=await supabase.from("movimentacoes").insert(dados);
      error=r.error;
      if(!error)await registrarLog({acao:"criou",tabela:"movimentacoes",detalhes:`${tipo==="entrada"?"+":"-"} R$ ${dados.valor.toFixed(2)}`});
    }
    if(error)setMensagem("Erro ao salvar.");
    else{setMensagem(editandoId?"Atualizado!":"Salvo!");resetForm();setShowForm(false);carregarMovimentacoes();}
    setLoading(false);setTimeout(()=>setMensagem(""),3000);
  }

  async function excluirMov(id:string){
    if(!confirm("Excluir?"))return;
    const{data:ant}=await supabase.from("movimentacoes").select("*").eq("id",id).single();
    await supabase.from("movimentacoes").delete().eq("id",id);
    await registrarLog({acao:"excluiu",tabela:"movimentacoes",registroId:id,dadosAnteriores:ant});
    setMensagem("Excluído!");carregarMovimentacoes();setTimeout(()=>setMensagem(""),3000);
  }

  function fmt(v:number){return v.toLocaleString("pt-BR",{style:"currency",currency:"BRL"});}

  function mesAnterior(){if(mes===0){setMes(11);setAno(ano-1);}else setMes(mes-1);}
  function mesProximo(){if(mes===11){setMes(0);setAno(ano+1);}else setMes(mes+1);}

  const entradas=movs.filter(m=>m.tipo==="entrada");
  const saidas=movs.filter(m=>m.tipo==="saida");
  const totalEntradas=entradas.reduce((a,m)=>a+m.valor,0);
  const totalSaidas=saidas.reduce((a,m)=>a+m.valor,0);
  const saldo=totalEntradas-totalSaidas;

  function getCategoriaNome(id:string){
    const allCats=[...catEntrada,...catSaida];
    return allCats.find(c=>c.id===id)?.nome||"Sem categoria";
  }

  const fpLabels:Record<string,string>={cartao:"Cartão",pix_santander:"Pix Santander",pix_inter:"Pix Inter",rom_card:"Rom Card",app:"App",prefeitura:"Prefeitura",voucher:"Voucher",dinheiro:"Dinheiro"};
  const fpIcons:Record<string,string>={cartao:"💳",pix_santander:"📱",pix_inter:"📱",rom_card:"💳",app:"📲",prefeitura:"🏛️",voucher:"🎫",dinheiro:"💵"};

  return(
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Movimentações</h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">Registre entradas e saídas</p>
        </div>
        <button onClick={novoLancamento} className="px-5 py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all text-sm shadow-md shadow-emerald-200">
          + Nova Movimentação
        </button>
      </div>

      <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-4 flex items-center justify-between">
        <button onClick={mesAnterior} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">← Anterior</button>
        <div className="text-center"><p className="font-bold capitalize">{mesesNomes[mes]}</p><p className="text-sm text-[var(--color-text-muted)]">{ano}</p></div>
        <button onClick={mesProximo} className="px-4 py-2 rounded-xl bg-[var(--color-bg)] text-sm font-medium hover:bg-[var(--color-border)] transition">Próximo →</button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {[{l:"Entradas",v:fmt(totalEntradas),c:"text-emerald-600"},{l:"Saídas",v:fmt(totalSaidas),c:"text-red-500"},{l:"Saldo",v:fmt(saldo),c:saldo>=0?"text-emerald-600":"text-red-500"}].map(c=>(
          <div key={c.l} className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-xl p-4 text-center">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">{c.l}</p>
            <p className={`font-bold ${c.c}`}>{c.v}</p>
          </div>
        ))}
      </div>

      {mensagem&&<div className={`p-3 rounded-xl text-sm font-medium text-center ${mensagem.includes("Erro")?"bg-red-50 text-red-600":"bg-emerald-50 text-emerald-700"}`}>{mensagem}</div>}

      {showForm&&(
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-6">
          <div className="flex items-center justify-between mb-5">
            <h2 className="font-bold">{editandoId?"Editar":"Nova"} Movimentação</h2>
            <button onClick={()=>{setShowForm(false);resetForm();}} className="w-8 h-8 rounded-lg hover:bg-[var(--color-bg)] flex items-center justify-center text-[var(--color-text-muted)]">✕</button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex gap-3">
              <button type="button" onClick={()=>{setTipo("entrada");const c=catEntrada;if(c.length>0)setCategoriaId(c[0].id);}} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo==="entrada"?"bg-emerald-600 text-white shadow-md":"bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▲ Entrada</button>
              <button type="button" onClick={()=>{setTipo("saida");const c=catSaida;if(c.length>0)setCategoriaId(c[0].id);}} className={`flex-1 py-3 rounded-xl font-semibold text-sm transition-all ${tipo==="saida"?"bg-red-500 text-white shadow-md":"bg-[var(--color-bg)] text-[var(--color-text-muted)] border border-[var(--color-border)]"}`}>▼ Saída</button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div><label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Data</label><input type="date" value={data} onChange={e=>setData(e.target.value)} required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"/></div>
              <div><label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Valor (R$)</label><input value={valor} onChange={e=>setValor(e.target.value)} placeholder="0,00" required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"/></div>
              <div><label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Categoria</label><select value={categoriaId} onChange={e=>setCategoriaId(e.target.value)} required className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm">{cats.map(c=><option key={c.id} value={c.id}>{c.nome}</option>)}</select></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div><label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Observação (opcional)</label><input value={observacao} onChange={e=>setObservacao(e.target.value)} placeholder="Ex: Venda balcão" className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm"/></div>
              {tipo==="entrada"&&(
                <div>
                  <label className="block text-xs font-semibold mb-1 text-[var(--color-text-muted)]">Forma de Pagamento</label>
                  <select value={formaPagamento} onChange={e=>setFormaPagamento(e.target.value)} className="w-full px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm">
                    <option value="">Selecione</option>
                    <option value="cartao">💳 Cartão</option>
                    <option value="pix_santander">📱 Pix Santander</option>
                    <option value="pix_inter">📱 Pix Inter</option>
                    <option value="rom_card">💳 Rom Card</option>
                    <option value="app">📲 App</option>
                    <option value="prefeitura">🏛️ Prefeitura</option>
                    <option value="voucher">🎫 Voucher</option>
                    <option value="dinheiro">💵 Dinheiro</option>
                  </select>
                </div>
              )}
            </div>
            <button type="submit" disabled={loading} className="w-full py-3 bg-gradient-to-r from-emerald-600 to-emerald-500 text-white font-semibold rounded-xl hover:from-emerald-700 hover:to-emerald-600 transition-all disabled:opacity-50 text-sm shadow-md shadow-emerald-200">
              {loading?"Salvando...":editandoId?"Atualizar":"Salvar"}
            </button>
          </form>
        </div>
      )}

      {movs.length===0?(
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl p-12 text-center text-[var(--color-text-muted)] text-sm">Nenhuma movimentação em {mesesNomes[mes]}/{ano}.</div>
      ):(
        <div className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
          {movs.map(m=>(
            <div key={m.id} className="p-4 flex items-center justify-between hover:bg-[var(--color-bg)] transition-colors border-b border-[var(--color-border)] last:border-b-0">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-sm shrink-0 ${m.tipo==="entrada"?"bg-emerald-50 text-emerald-600":"bg-red-50 text-red-500"}`}>
                  {m.tipo==="entrada"?(fpIcons[m.forma_pagamento||""]||"▲"):"▼"}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{getCategoriaNome(m.categoria_id)}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {new Date(m.data+"T12:00:00").toLocaleDateString("pt-BR")}
                    {m.forma_pagamento&&` · ${fpIcons[m.forma_pagamento]||"💰"} ${fpLabels[m.forma_pagamento]||m.forma_pagamento}`}
                    {m.observacao&&` · ${m.observacao}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className={`font-bold text-sm ${m.tipo==="entrada"?"text-emerald-600":"text-red-500"}`}>{m.tipo==="entrada"?"+":"-"} {fmt(m.valor)}</span>
                <button onClick={()=>editarMov(m)} className="p-1.5 rounded-lg hover:bg-blue-50 text-[var(--color-text-muted)] hover:text-blue-600 transition text-sm">✏️</button>
                <button onClick={()=>excluirMov(m.id)} className="p-1.5 rounded-lg hover:bg-red-50 text-[var(--color-text-muted)] hover:text-red-500 transition text-sm">🗑️</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
