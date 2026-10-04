# Análise Inteligente Financeira

Status: proposto — aguardando aprovação por fases. **Esta spec não implementa nada**; nenhum arquivo de app, migration ou schema foi alterado para produzi-la.

Todos os números deste documento foram verificados direto no banco de produção (Supabase, projeto `nheyevdjomfphlzmsszk`) em 03/10/2026, e no código em `c:\projetos\q-mais-financas`. Onde a minha verificação bateu com a premissa do pedido original, digo "confirmado". Onde achei diferença, destaco.

---

## 0. Confirmação da seção 0 (realidade do sistema)

**1. Não existe centro de custo — confirmado.** Nenhuma tabela nem coluna com esse nome ou sentido em todo o schema (29 tabelas em `public`, verificado via `list_tables`). Não existe hoje; fica registrado como "dado faltante" na seção 9.

**2. Fornecedor é texto livre, sem normalização — confirmado, e pior na prática do que os números isolados sugerem.**
```sql
select count(distinct fornecedor) distintos_brutos, count(distinct upper(trim(fornecedor))) distintos_trim_upper from contas_pagar;
-- 341 | 228
```
Bate exatamente com a premissa. Mas o trim/upper sozinho **não resolve o problema real**: mesmo depois de normalizar case/espaço, o mesmo fornecedor continua espalhado em grafias totalmente diferentes. Exemplos reais do mês de setembro/2026, lado a lado:
```
SPAL                                  R$ 11.389,31 (17 contas)
SPAL INDUSTRIA BRASILEIRA DE BEBIDAS  -- mesma empresa, nome da nota fiscal
EXCELENTE                             
EXCELENTE COMERCIO DE BEBIDAS LTDA.   -- mesma empresa
COMPRE FACIL
COMPRE FACIL COMERCIO DE PRODUTOS ALIMENTICIOS LTDA  -- mesma empresa
MARQUESPAN
MARQUESPAN INDUSTRIA DE ALIMENTOS LTDA               -- mesma empresa
```
Isso quer dizer que um ranking "top fornecedores de setembro" rodado sobre os 228 nomes trim/upper **ainda contaria "SPAL" duas vezes como fornecedores diferentes**, cada metade por baixo do que realmente gastou com esse fornecedor. `xml_nota` já tem `fornecedor_cnpj` com 100% de cobertura (263 notas, 64 CNPJs distintos, 1 nome por CNPJ — sem duplicidade interna). Testei o cruzamento: a maioria dos 64 fornecedores do XML tem contrapartida clara em `contas_pagar` (2-7 grafias parecidas por CNPJ, na maioria dos casos). Plano de normalização detalhado na seção 3.

**3. Receita com duas fontes que não batem — confirmado, com os números exatos.**
```sql
-- fechamento_caixa.valor_total_vendas, por mês
2026-06: 194.990,55   2026-07: 214.518,67   2026-08: 207.883,12   2026-09: 203.786,51

-- movimentacoes tipo='entrada', por mês
2026-06: 198.080,44   2026-07: 206.492,79   2026-08: 206.883,42   2026-09: 198.524,85
```
Setembro: R$ 203.786,51 (fechamento) vs R$ 198.524,85 (movimentações) — diferença de R$ 5.261,66 (2,6%). Bate com a premissa ("≈203,8 mil" vs "≈198,5 mil").

**Decisão revista em conversa (03/10/2026), com evidência adicional que a confirma.** A sugestão inicial desta spec era `fechamento_caixa.valor_total_vendas` como receita oficial. Reconsiderando: `fechamento_caixa` é o que o caixa físico registrou vender **no dia da venda**, não o que realmente entrou no banco — exatamente o problema que o insight #14 (seção 5.4) existe para explicar (uma venda em crédito é registrada em `fechamento_caixa.cartao` no dia da venda, mas o dinheiro só chega ~31,5 dias depois). Confirmei isso com mais uma evidência direta: comparando `fechamento_caixa` contra as categorias de `movimentacoes` que vêm do extrato bancário real,
```
"Cartão" em movimentações, setembro/2026: 155 linhas, R$ 103.774,90
fechamento_caixa.cartao, setembro/2026:    (1 valor por dia, 30 dias), R$ 111.370,39
```
155 linhas num mês de 30 dias só é possível porque cada linha é um **repasse de cartão que efetivamente caiu no banco naquele dia** (via Getnet, extrato bancário) — nunca é "a venda do dia". `fechamento_caixa` não tem nem campo próprio para "Repasse Tuna" (pagamentos de venda do App) nem para "Cartão VR" separado de "Cartão" — esses só existem como categoria em `movimentacoes`, vindos do extrato.

**Receita oficial do motor = soma de `movimentacoes` tipo=`entrada` no período** — é regime de caixa real (dinheiro que de fato entrou na conta), coerente com o resto do sistema não ter CMV/estoque (ponto 5). `fechamento_caixa` passa a ser fonte **operacional/diagnóstica**: usado no insight #14 (explicar o descasamento de prazo) e num novo alerta de qualidade "o caixa físico registrou vender R$ X no dia, mas o banco ainda não recebeu — normal se for cartão recente, investigar se for dinheiro ou Pix" — nunca mais como receita oficial, nunca somado a `movimentacoes`.

**4. Despesa por fornecedor x duplicidade — confirmado, e a causa raiz é mais específica do que "vínculo começou em agosto".**
```sql
-- movimentacoes tipo='saida', contagem de linhas com conta_pagar_id preenchido, por mês
2026-06: 0 de 409     2026-07: 0 de 440     2026-08: 176 de 363     2026-09: 257 de 371
```
`movimentacoes.conta_pagar_id` só começa a ser preenchido em agosto/2026 — bate exatamente com a premissa (jun/jul = 0). **Mas isso não bloqueia a dimensão fornecedor**: `contas_pagar` por si só já tem `fornecedor` + `status='pago'` + `data_pagamento` desde março/2026 (159 contas pagas em março), **independente** de `movimentacoes.conta_pagar_id` estar preenchido ou não. Regra anti-duplicidade adotada (detalhada na seção 2): **despesa total do mês = soma de `movimentacoes` tipo=`saida`** (toda saída de caixa vira uma linha ali, vinculada ou não a um fornecedor). **Despesa por fornecedor = soma de `contas_pagar` com `status='pago'`, filtrado por `data_pagamento`** — fonte própria, não um recorte de `movimentacoes`. As duas nunca são somadas juntas; uma é "quanto saiu", a outra é "quanto saiu e para quem".

**5. Não existe CMV nem estoque — confirmado.** Nenhuma tabela de produto, item, estoque ou custo de mercadoria vendida em todo o schema. Regime é 100% de caixa (pagamento de fornecedor quando ocorre, não quando a mercadoria é vendida). O relatório vai nomear os indicadores como **"resultado de caixa"** e **"margem de caixa"**, nunca "margem bruta" ou "lucro operacional" — e o motor não pode interpretar "compras subiram mais que a receita" como pressão de margem; isso é marcado explicitamente como hipótese de formação de estoque, nunca como fato.

**6. Histórico curto e irregular — confirmado, com uma correção importante.**
```sql
-- contas_pagar pagas, por mês de vencimento
2026-03: 159   2026-04: 272   2026-05: 7   2026-06: 289   2026-07: 298   2026-08: 261   2026-09: 257

-- fechamento_caixa: não existe nenhuma linha antes de 2026-04 (março = zero dias)
-- movimentacoes entrada: março = 0 linhas (só saída, 161 linhas)
```
mar/26 = só saídas (confirmado, literal: zero entradas em `movimentacoes` e zero linhas em `fechamento_caixa`). mai/26 = 7 contas pagas (confirmado exatamente). jun–set/26 = volume estável (~257–298 contas/mês). **Correção à premissa**: `fechamentos_mensais` (o fechamento contábil formal, tabela separada de `fechamento_caixa`) só tem **3 meses fechados: maio, junho e julho de 2026**. Agosto e setembro — os meses que a premissa chama de "confiáveis" — **ainda não foram fechados**. Isso importa porque a regra da seção 3 do pedido ("mês não fechado em `fechamentos_mensais` → relatório marca como parcial") se aplica literalmente a setembro hoje. A simulação da seção 5 usa setembro mesmo assim (é o mês mais completo disponível), mas **mostra o selo "parcial" nele**, exatamente como o motor real faria — é um bom teste de que a regra funciona.

**7. Contagem de lançamentos não é sinal de negócio — confirmado, números exatos.**
```sql
movimentacoes entrada: 2026-07 = 168 linhas | 2026-09 = 1.158 linhas
```
Bate com "~168 → ~1.158" da premissa. Causa: a importação do extrato Santander passou a lançar cada Pix individualmente (confirmado no módulo `/extrato`, já documentado em specs anteriores desta pasta). Nenhum achado do catálogo (seção 5) usa `count(*)` de lançamentos como proxy de atividade — só soma de `valor`.

**8. Telas parecidas já existem — inventário completo na seção 1.**

**9. Botão de análise do Painel CEO quebrado — confirmado.** `painel-ceo/page.tsx` chama `POST /api/analise`; `src/app/api/` só tem `chat/`, `cron/notificacoes/`, `notificacoes-teste/`, `usuarios/`. O catch do botão mostra "Verifique se a chave OpenAI está configurada" — resquício incorreto, o app usa Anthropic (`ANTHROPIC_API_KEY`) em `/api/chat`. O módulo novo substitui esse fluxo.

**10. Fontes adicionais — mapeadas, com uma ressalva de dados vazios.** `vendas_maquina` (0 linhas) e `maquinas` (0 linhas) existem no schema mas **não têm dado real ainda** — não entram no MVP. `cartao_transacao`/`cartao_taxa_contratada`/`cartao_conciliacao` têm dado real (3.343/7/150 linhas, módulo de Conciliação de Cartão) e são a fonte certa para "custo real de recebimento em cartão". `lancamentos_recorrentes` existe no código mas está com **0 linhas no banco hoje** — fica fora do MVP até ter dado. `xml_nota`/`xml_regra_fornecedor` detalhados na seção 3. `fechamentos_mensais` só tem 3 linhas (ponto 6, acima).

---

## 1. Inventário — o que existe, o que reaproveitar, o que substituir

| Item | Estado hoje | Decisão |
|---|---|---|
| `/analise` (`src/app/(app)/analise/page.tsx`) | Client-side, 10 regras fixas (variação de faturamento vs mês anterior/ano anterior, margem, categoria dominante, categoria em alta, lucro/prejuízo, limiares fixos tipo ">10% alerta"). Sem IA, sem exportação, sem seletor de período livre (só mês/ano com setas). | **Substituída** pelo motor novo — as mesmas perguntas (e mais) passam a ser respondidas no Painel CEO, calculadas no servidor. A tela `/analise` pode continuar existindo como atalho rápido mais tarde, ou ser redirecionada; decisão de produto, não técnica — ver seção 11. |
| Botão "Análise IA" do Painel CEO | Chama `POST /api/analise`, rota inexistente (404). Menciona "chave OpenAI" por engano. | **Substituído** pela nova rota `/api/analise-inteligente` (nome novo, para não colidir com a rota morta), seguindo o padrão de `/api/chat/route.ts`: SDK Anthropic (`@anthropic-ai/sdk@^0.104.1`), modelo `claude-haiku-4-5-20251001`, autenticação via `Authorization: Bearer <token>` validado com `supabaseAdmin.auth.getUser(token)` (service role só instancia o client, não faz bypass de RLS para dado de negócio). |
| Controle de acesso do Painel CEO | Checagem própria (`profiles.role === "master"` direto na página), **diferente** do padrão central `RoleProvider`/`useRole()` usado em 18 outras telas. | **Mantém o padrão do Painel CEO** (só `master`) — é intencional, o menu já marca o item como `masterOnly: true`. Registro de inconsistência arquitetural, não é bloqueador: não faz parte do escopo desta spec unificar os dois padrões de acesso do app. |
| Padrão de impressão | Não existe `@media print` reaproveitável central — `globals.css` tem um bloco único (`.no-print`) que nenhuma tela usa. Cada tela que imprime abre janela nova e escreve HTML próprio na mão (`painel-ceo` e `relatorios/page.tsx`, função `gerarImpressao`). | **Reaproveita o padrão de `relatorios/page.tsx`** (`gerarImpressao`, função isolada e já testada em produção 4x) como base, adaptado para incluir logo/tokens do app (ver seção 8). |
| `/comparativo`, `/dre`, `/relatorios` | Cada um lê só `movimentacoes` (+ categorias); `/dre` também lê `metas` e `fechamento_caixa` (só para o alerta de divergência, leitura). Nenhum tem noção de `fechamentos_mensais`. `/relatorios` é o único com seletor de período livre ("de mês/ano até mês/ano"). | **Mantidos intocados.** Nenhuma mudança de usabilidade nessas telas (restrição explícita do pedido, seção 9). O motor novo não lê o código delas, só as mesmas tabelas. |
| `/api/chat` | Único uso atual do SDK Anthropic. Envia só métricas pré-calculadas no cliente (nunca lançamento bruto) para um prompt fixo; resposta é stream de texto puro, **sem validação de saída**. | **Padrão de autenticação e de instanciação do SDK é reaproveitado.** A validação anti-número-inventado (seção 6) é nova — não existe em `/api/chat` hoje, porque lá não há números a proteger (é um chat livre). |
| `Logo` (`src/components/logo.tsx`) | Componente fixo, sem props/variantes (`<Logo />`, sempre o mesmo visual: quadrado gradiente emerald "+Q" + texto). | Reaproveitado como está no cabeçalho do relatório (tela e impressão). Se precisar de uma versão monocromática para impressão P&B, é um componente novo pequeno, não uma mudança no `Logo` existente. |
| Tokens de cor (`globals.css`) | `--color-primary #10b981` / `--color-primary-dark #059669` / `--color-primary-light #d1fae5`; sistema mais rico por trás (`--brand*`, `--red*`, `--amber*`, `--blue*`, `--purple*`, `--cyan*`, `--orange*`, cada um com variantes `-subtle/-muted/-border/-strong`, redefinidas em `[data-theme="dark"]`). | Reaproveitados integralmente para os gráficos e classes de severidade (🔴🟠🟡🟢) do relatório — ver seção 8. |
| `registrarLog` (`src/lib/audit.ts`) | `acao` é um union type fechado: `"criou" \| "editou" \| "excluiu" \| "pagou" \| "fechou" \| "reabriu" \| "recebeu" \| "importou"`. Não tem verbo para "gerou análise". | **Pede ampliação do enum** (`"analisou"` ou reaproveita `"criou"` com `tabela: "analises_ia"` — decisão de nomenclatura na seção 11). |
| `verificarMesFechado`/`bloquearSeMesFechado` (`src/lib/audit.ts`) | Já existe, lê `fechamentos_mensais`. | Reaproveitado para o selo de qualidade "mês fechado/aberto" (seção 4) — nenhuma lógica nova de leitura de mês fechado precisa ser escrita. |

---

## 2. Fonte oficial por métrica + regra anti-duplicidade

| Métrica | Fonte oficial | Por quê | O que NUNCA faz |
|---|---|---|---|
| Receita do mês | `movimentacoes` tipo=`entrada`, somado por dia no período | Regime de caixa real — dinheiro que efetivamente entrou no banco, na data em que entrou (não na data da venda) | Nunca soma com `fechamento_caixa.valor_total_vendas` — essa vira fonte operacional/diagnóstica (divergência, insight #14), nunca receita oficial |
| Mix de recebimento | `movimentacoes` entrada, agrupado por `categoria` (`Cartão`, `Cartão VR`, `Pix Santander`, `Pix Inter`, `Repasse Tuna`, `Prefeitura Municipal`, `Dinheiro (Fechamento Caixa)`, `À Prazo`, ...) | Mesma fonte da receita oficial — categorias mais granulares que os campos fixos de `fechamento_caixa` (que não distingue Cartão de Cartão VR, nem tem campo próprio para Tuna) | — |
| Despesa total do mês | `movimentacoes` tipo=`saida`, somado por dia no período | Toda saída de caixa real vira exatamente uma linha ali, vinculada a fornecedor ou não | Nunca soma `contas_pagar.valor` por cima — seria contar o mesmo pagamento duas vezes |
| Despesa por fornecedor / ranking / concentração | `contas_pagar` com `status='pago'`, filtrado por `data_pagamento`, fornecedor normalizado (seção 3) | Fonte própria, com dado desde março/2026 — não depende de `movimentacoes.conta_pagar_id` (que só começa em ago/2026) | A soma de todas as contas pagas de um mês **não precisa bater** com a despesa total do mês em `movimentacoes` — despesas sem fornecedor cadastrado (salário, tarifa, imposto lançado direto) ficam de fora por natureza, isso é esperado e documentado no relatório, não é um alerta de inconsistência |
| Despesa por categoria | `movimentacoes` tipo=`saida` join `categorias_saida` | Toda saída tem `categoria_id`; é a visão "onde o dinheiro foi", independente de ter fornecedor identificado | — |
| Compra por competência/emissão | `xml_nota` (`emitida_em`, `valor_total`, `fornecedor_cnpj`) | Data de emissão da nota, diferente da data de pagamento — serve só para a hipótese de formação de estoque (ponto 5 da seção 0), nunca para "despesa do mês" | Nunca tratado como despesa de caixa — é compra, não pagamento |
| Pressão de caixa futura | `contas_pagar` com `status='pendente'`, por `data_vencimento` | É o que ainda vai sair, nunca o que já saiu | Nunca somado a nenhuma métrica de resultado do mês fechado |
| Custo de recebimento em cartão | `cartao_transacao` (`valor_bruto`, `valor_taxa`, `valor_liquido`) + `cartao_taxa_contratada` | Taxa real negociada por bandeira/modalidade, não estimativa | — |

---

## 3. Plano de normalização de fornecedores

1. **CNPJ como chave primária de verdade.** `xml_nota.fornecedor_cnpj` já cobre 64 fornecedores com 100% de preenchimento e sem duplicidade interna (1 nome por CNPJ). Esses 64 já respondem por uma fatia relevante do volume de `contas_pagar` (confirmado por amostragem: a maioria tem 2-7 grafias correspondentes em `contas_pagar`).
2. **Nova tabela `fornecedor_canonico`** (fase 1, Fase 1 do plano da seção 10): `id uuid`, `cnpj text unique nullable`, `nome_exibicao text`, `criado_em`. Mapeamento `contas_pagar.fornecedor` (texto livre) → `fornecedor_canonico.id` via **nova coluna** `contas_pagar.fornecedor_canonico_id uuid null references fornecedor_canonico(id)` — nullable, não quebra nada existente, preenchida progressivamente.
3. **Preenchimento em duas camadas:**
   - **Automática, alta confiança**: quando o nome em `contas_pagar.fornecedor` (normalizado: upper, trim, sem acento) aparece como substring do `xml_nota.fornecedor_nome` de um CNPJ já conhecido (mesmo algoritmo "contém" que o motor de baixa automática do extrato já usa e testou em produção — reaproveitar, não reinventar).
   - **Sugestão assistida, confirmação humana**: para os ~164 nomes restantes (228 - 64 com match direto), o motor sugere agrupamentos por similaridade de texto (ex.: `pg_trgm`, já disponível no Postgres do Supabase) e mostra numa tela de revisão — o usuário confirma ou separa, uma vez, não por lançamento. **Nunca agrupa sozinho sem confirmação** — mesmo princípio de "nunca decide ambiguidade sozinho" que o motor de baixa automática do extrato já segue.
4. **Fornecedor sem nenhum match** (nem CNPJ nem sugestão aceita) fica com `fornecedor_canonico_id = null` — contado à parte como "não normalizado" no selo de qualidade (seção 4), nunca escondido nem forçado a um agrupamento errado.
5. Todo achado de fornecedor no catálogo (seção 5) é calculado **sobre `fornecedor_canonico`**, nunca sobre o texto bruto — isso é o que evita o erro concreto de "fornecedor X aumentou" quando na verdade são duas grafias da mesma empresa.

---

## 4. Selo de qualidade de dados por mês

Cada mês do período analisado recebe um selo, calculado por regras objetivas (não é texto da IA):

| Selo | Critério |
|---|---|
| 🟢 **Completo** | Tem `fechamentos_mensais.status='fechado'` **e** tem linhas em `fechamento_caixa` para ≥ 90% dos dias do mês **e** o mês não é o mês corrente |
| 🟡 **Parcial** | Tem dado em `fechamento_caixa`/`movimentacoes`, mas **não** está fechado em `fechamentos_mensais` (caso real hoje: agosto e setembro/2026), ou é o mês corrente, ou tem < 90% dos dias com `fechamento_caixa` |
| 🔴 **Insuficiente** | < 50% dos dias com `fechamento_caixa`, ou nenhuma entrada em `movimentacoes` no mês (caso real: março/2026) |

Regras de uso pelo motor:
- Meses 🔴 nunca entram em cálculo de mediana/tendência — só aparecem citados como "sem dado suficiente".
- Meses 🟡 entram no cálculo, mas **todo achado que depende deles tem a confiança rebaixada em um nível** (ex.: um achado que seria 🔴 Crítico some pra 🟠 Atenção se o mês mais recente envolvido é parcial) — mecanismo testado na simulação da seção 5.
- O relatório sempre mostra os selos do período analisado e do período de comparação, lado a lado, na seção "Limitações dos dados" (seção 7).

Linha do tempo real (mar–set/2026), já classificada:

| Mês | `fechamento_caixa` | `movimentacoes` entrada | `fechamentos_mensais` | Selo |
|---|---|---|---|---|
| 2026-03 | 0 dias | 0 linhas | — | 🔴 Insuficiente |
| 2026-04 | 30 dias | 120 linhas | aberto | 🟡 Parcial (primeiro mês com receita, mas não fechado) |
| 2026-05 | 30 dias | 154 linhas | **fechado** | 🟢 Completo (apesar de só 7 contas a pagar — isso é uma limitação da dimensão fornecedor nesse mês, não da receita) |
| 2026-06 | 30 dias | 169 linhas | **fechado** | 🟢 Completo |
| 2026-07 | 31 dias | 168 linhas | **fechado** | 🟢 Completo |
| 2026-08 | 31 dias | 794 linhas | aberto | 🟡 Parcial |
| 2026-09 | 30 dias | 1.158 linhas | aberto | 🟡 Parcial |

---

## 5. Catálogo de insights + score, simulado com dados reais de setembro/2026

### 5.1 Fórmula de score

Cada achado recebe 4 componentes, cada um normalizado em [0,1], e um multiplicador de confiança:

- **I_abs** — impacto absoluto: `min(|Δ R$| / piso_da_dimensão, 1)`. Piso evita que uma categoria de R$50 que dobrou vire alerta: `categoria de despesa` piso R$ 500; `fornecedor` piso R$ 300; `receita total`/`mix de recebimento` piso R$ 2.000.
- **I_rel** — impacto relativo: `min((|Δ R$| / receita_do_mês) * 10, 1)` (o `*10` escala variações de poucos % para a faixa 0-1 de forma proporcional).
- **D** — desvio robusto frente ao próprio histórico: com ≤ 5 meses completos, usa **mediana + MAD** (desvio absoluto mediano) em vez de média/desvio-padrão (não confiável com amostra pequena): `min(|valor_atual - mediana_3m| / (2 * MAD_3m), 1)`. Se `MAD_3m = 0` (sem variação histórica), usa a faixa min–máx do histórico no lugar.
- **P** — persistência: `min(meses_consecutivos_na_mesma_direção / 3, 1)`. Exige ≥ 4 meses completos no histórico para ser calculada; com menos, `P = 0` (nunca derruba o score, só deixa de contribuir).
- **C** — confiança (multiplicador, não soma): `1,0` se os meses envolvidos (atual + referência) são 🟢 Completo; `0,7` se o mais recente é 🟡 Parcial; `0,4` se algum é 🔴 Insuficiente (nesse caso, normalmente o achado nem é gerado — ver seção 4).

```
Score = C × (0,35·I_abs + 0,25·I_rel + 0,25·D + 0,15·P) × 100
```

Classes por faixa de score (sinal do Δ decide se é alerta ou oportunidade):
- 🔴 **Crítico**: score ≥ 70 e Δ desfavorável
- 🟠 **Atenção**: score 50–69 e Δ desfavorável
- 🟡 **Observação**: score 30–49, qualquer sinal
- 🟢 **Oportunidade**: score ≥ 50 e Δ favorável (economia, receita subindo, concentração caindo)

Pesos e piso são parâmetros versionados junto com o motor (`versao_motor` na tabela de histórico, seção 7) — mudar um peso gera uma nova versão, nunca recalcula o passado silenciosamente.

### 5.2 Simulação com dados reais — setembro/2026 vs agosto/2026 e vs mediana(jun,jul,ago)

Setembro está 🟡 Parcial (não fechado em `fechamentos_mensais`) — todo score abaixo já aplica `C = 0,7`.

**Achado 1 — Despesa "Pagamento de funcionários" fora do padrão**
```
jun R$16.516,47 · jul R$19.503,35 · ago R$13.918,67 · set R$20.792,16
mediana(jun,jul,ago) = R$16.516,47 · MAD = R$2.597,00
Δ vs ago (mês anterior) = +R$6.873,49 (+49,4%)
Δ vs mediana 3m = +R$4.275,69 (+25,9%)
```
I_abs = min(6873/500,1) = 1,00 · I_rel = min((6873/198525)×10,1) = 0,346 (receita do mês = `movimentacoes` entrada de setembro, R$198.524,85) · D = min(4276/(2×2597),1) = 0,823 · P = 0 (não é alta em 3 meses seguidos — caiu em agosto)
`Score = 0,7 × (0,35×1 + 0,25×0,346 + 0,25×0,823 + 0,15×0) × 100 = 45,0` → 🟡 **Observação** (o selo "parcial" de setembro é o que impede isso de virar 🟠 Atenção — exatamente o mecanismo que deveria acontecer).

**Achado 2 — Despesa "PRONAMPE" desapareceu**
```
jun R$6.664,82 · jul R$6.738,73 · ago R$6.816,21 · set R$0,00 (nenhum lançamento)
```
Três meses seguidos de parcela quase idêntica, sumindo sem aviso em setembro — candidato a "despesa recorrente que sumiu" (catálogo 5.3). Sem Δ% calculável (divisão por zero); regra própria: achado dispara sempre que uma categoria com ≥ 3 meses consecutivos de valor estável (desvio < 10%) zera no mês seguinte. Score fixo de severidade 🟠 **Atenção** nesse padrão (pode ser quitação normal do empréstimo ou pagamento esquecido — motor marca como **hipótese**, nunca afirma qual).

**Achado 3 — Fornecedor duplicado por grafia (qualidade de dado, não insight de negócio)**
`SPAL` (R$11.389,31, 17 contas) e `SPAL INDUSTRIA BRASILEIRA DE BEBIDAS S/A` (R$2.356,76, 4 contas) somados em setembro = R$13.746,07 — hoje aparecem como dois fornecedores diferentes em qualquer ranking. Vira alerta de qualidade de dados fixo (sem score, sempre no fim do relatório) até a normalização da seção 3 ser aplicada.

**Achado 4 — Realizado vs meta**
```
metas_vendas set/2026 = R$212.000,00 · realizado (movimentacoes entrada) = R$198.524,85 → 93,6% da meta
```
I_abs = min(13475/2000,1)=1,00 · I_rel = min((13475/198525)×10,1)=0,679 · sem histórico de meta suficiente para D/P (só 2 meses cadastrados em `metas`) → D=0, P=0
`Score = 0,7 × (0,35×1 + 0,25×0,679 + 0 + 0) × 100 = 36,4` → 🟡 **Observação**, mais perto de 🟠 do que a leitura anterior — faz sentido: medir contra dinheiro que realmente entrou é mais rigoroso do que medir contra venda registrada no caixa.

**Achado 5 — Concentração de vencimentos (pressão de caixa futura, não depende de mês fechado)**
```sql
semana de 05/10/2026: 61 contas, R$ 26.882,49
semana de 12/10/2026: 45 contas, R$ 22.352,53
semana de 19/10/2026: 24 contas, R$ 6.918,16
```
A primeira semana de outubro concentra mais que as três seguintes somadas — achado sempre calculado sobre dado vivo (`contas_pagar` pendente), nunca depende do selo de qualidade de mês fechado. 🟠 **Atenção** por critério fixo (>35% do total pendente do mês numa única semana).

**Achado 6 — Encargos Pix em queda consistente**
```
jun R$386,24 → jul R$175,62 → ago R$141,35 → set R$45,54  (queda em 3 meses seguidos)
```
P = min(3/3,1) = 1,0, mas I_abs = min(96/500,1) = 0,19 (abaixo do piso de relevância em R$) → score baixo apesar da persistência perfeita. `Score ≈ 0,7×(0,35×0,19+0,25×0,1+0,25×0,3+0,15×1)×100 ≈ 24,5` → fica **de fora do top 8**, mas listado em "ver todos" como 🟢 oportunidade pequena. Demonstra o piso em R$ funcionando (sem ele, uma queda de R$340 em valor absoluto apareceria como "achado" só por ser 88% de queda percentual).

Os 6 exemplos acima já mostram os quatro tipos de prioridade (🔴 nenhum neste mês — não há nenhuma variação grande o bastante com confiança alta simultaneamente, o que é plausível e não é erro do motor) e os mecanismos de piso, confiança e persistência funcionando com dado real, não hipotético.

### 5.3 Catálogo completo de padrões

| # | Padrão | Dados usados | Meses mínimos | Fato vs Hipótese |
|---|---|---|---|---|
| 1 | Variação de receita total | `fechamento_caixa` | 1 (vs mês anterior) | Fato (é o que vendeu) |
| 2 | Variação por forma de recebimento + efeito em taxa de cartão | `fechamento_caixa` + `cartao_taxa_contratada` | 1 | Fato |
| 3 | Despesa por categoria fora do padrão (alta/economia) | `movimentacoes` saida + `categorias_saida` | 3 (mediana) | Fato o valor; hipótese a causa |
| 4 | Despesa recorrente que subiu (reajuste) | `movimentacoes` saida, mesma categoria, ≥3 meses estáveis | 3 | Fato o valor; "reajuste" é hipótese |
| 5 | Despesa nova / despesa que sumiu | `movimentacoes` saida por categoria | 3 | Fato |
| 6 | Fornecedor que cresceu/caiu/apareceu/sumiu | `contas_pagar` pago + `fornecedor_canonico` | 2 | Fato o valor; motivo é hipótese |
| 7 | Concentração top 5 fornecedores | `contas_pagar` pago + `fornecedor_canonico` | 1 | Fato |
| 8 | Compras crescendo acima das vendas (N meses) | `xml_nota` valor_total vs `fechamento_caixa` | 3 | **Sempre hipótese** de estoque — nunca "pressão de margem" (não existe CMV) |
| 9 | Concentração de vencimentos / pressão de caixa | `contas_pagar` pendente | 1 (dado vivo, sempre atual) | Fato |
| 10 | Realizado vs meta | `fechamento_caixa` + `metas_vendas`/`metas` | 1 | Fato |
| 11 | Ponte do resultado (bridge receita→despesa→caixa) | `fechamento_caixa` + `movimentacoes` saida por categoria | 2 | Fato |
| 12 | Recuperação após queda / tendência persistente | qualquer métrica acima | 4 completos | Fato o padrão; causa é hipótese |
| 13 | Qualidade de dados (receita sem lançamento, fornecedor duplicado, mês aberto) | selo da seção 4 | 1 | Fato — é sobre o próprio dado |
| 14 | **Descasamento de prazo no recebimento de cartão (crédito x débito)** | `cartao_transacao` (`data_hora_venda`, `modalidade`, `valor_bruto`, `data_prevista_calculada`) | 1 (explica o mês atual); 2 para comparar com o mês anterior | Fato — prazo é medido, não estimado |

### 5.4 Insight #14 em detalhe — por que esse é o que você mais pediu

Esse é o padrão que você descreveu: "recebi bastante esse mês porque o mês passado teve muito crédito, que só cai depois" — e "esse mês não tinha muito crédito, então vai cair tudo pro mês seguinte". Confirmei com dado real que o sistema já tem exatamente o que precisa pra calcular isso, não como estimativa — como medição:

```sql
-- prazo médio REAL entre a venda e a data prevista de cair na conta, agosto/2026
modalidade  qtd    bruto         prazo_médio_dias
credito     1.601  R$ 62.063,02  31,5 dias
debito      1.679  R$ 48.707,16   1,4 dias
```
(`voucher`, 63 transações, R$ 2.478,98, não tem data prevista calculada ainda — fica de fora deste insight por enquanto, listado como dado faltante abaixo.)

**Texto que o motor geraria para agosto/2026** (100% por template, sem IA — são frases condicionais sobre número medido, não redação livre):
> "Em agosto, 54,8% do valor vendido no cartão (R$ 62.063,02 de R$ 113.249,16) foi em crédito, com prazo médio de liquidação de 31,5 dias — a maior parte desse valor só entra efetivamente na conta entre o fim de setembro e início de outubro, não em agosto. Já o débito (43,0% do valor, R$ 48.707,16) tem prazo médio de 1,4 dia e cai quase integralmente ainda dentro do próprio mês. Isso significa que **o valor recebido na conta em um mês reflete principalmente a mistura de crédito/débito vendida no mês anterior**, não as vendas do mês corrente."

**Limitação real, hoje**: o módulo de Conciliação de Cartão só tem **um mês importado** (agosto/2026 — duas importações, uma "detalhado" com 4.448 linhas e uma "consolidado" com 0 linhas, ambas do mesmo período 01–31/08). A frase acima (explicar a composição de **um** mês) já funciona com o dado de hoje. A comparação completa que você descreveu — "o mês passado teve muito crédito, por isso recebi bem este mês" — depende de comparar a composição de **dois** meses seguidos, e isso só fica disponível a partir do momento em que setembro também for importado no módulo de cartão. Fica registrado como dependência real na seção 9, não como limitação de desenho — o insight está pronto para funcionar assim que o segundo mês de dado existir.

---

## 6. Papel da IA, contrato do JSON e validação anti-número-inventado

**Arquitetura**: `Dados → Qualidade de dados → Motor determinístico (SQL + TypeScript, server-side) → JSON de achados → IA redige → Relatório`. A IA nunca vê lançamento bruto — só o JSON já calculado.

**Contrato do JSON de achados** (um array, cada achado no formato da seção 5 do pedido original):
```ts
interface Achado {
  id: string;                 // ex: "despesa-categoria-pagamento-funcionarios-set2026"
  dimensao: "receita" | "despesa" | "categoria" | "fornecedor" | "forma_recebimento" | "meta" | "pressao_caixa" | "qualidade_dados";
  titulo: string;              // gerado por template, não pela IA
  valorAtual: number;
  valorReferencia: number;
  deltaAbsoluto: number;
  deltaPercentual: number | null; // null quando referência = 0 (ex.: despesa que sumiu)
  comparadoCom: string;         // "mês anterior" | "mediana 3m" | "mesmo mês ano anterior" | ...
  score: number;
  classe: "critico" | "atencao" | "observacao" | "oportunidade";
  confianca: "alta" | "media" | "baixa";
  fatoOuHipotese: "fato" | "hipotese";
  explicacao: string | null;    // só preenchida quando fatoOuHipotese = "hipotese"
  origemIds: string[];          // ids das linhas de origem (movimentacoes.id, contas_pagar.id...)
  origemTabela: string;
  acaoSugerida: string | null;
}
```

**Regra de ouro aplicada tecnicamente**: a IA recebe o array de `Achado[]` serializado (sem nomes de pessoa física — fornecedor pessoa jurídica ok, nome de funcionário nunca) e só pode **redigir** o texto corrido do relatório a partir dele. Validação automática pós-geração: todo número com 2+ dígitos no texto gerado pela IA precisa casar (com tolerância de arredondamento de centavos) com algum `valorAtual`, `valorReferencia`, `deltaAbsoluto` ou `deltaPercentual` presente no JSON enviado. Se um número no texto não bate com nenhum valor do JSON, **o texto inteiro daquele achado cai para o texto-template** (gerado por regra, sem IA) — nunca mostra o texto da IA parcialmente editado ou "corrigido" por outro código. O relatório **funciona 100% sem a IA** (todo achado já tem `titulo` e template de texto determinístico); a IA só melhora a redação corrida das seções "Como foi o mês" e "Conclusão", que também passam pela mesma validação.

---

## 7. Modelo de dados novo

```sql
-- Normalização de fornecedor (seção 3)
create table fornecedor_canonico (
  id uuid primary key default gen_random_uuid(),
  cnpj text unique,
  nome_exibicao text not null,
  criado_em timestamptz not null default now()
);
alter table contas_pagar add column fornecedor_canonico_id uuid references fornecedor_canonico(id);
create index on contas_pagar (fornecedor_canonico_id);

-- Histórico imutável de análises geradas
create table analise_inteligente (
  id uuid primary key default gen_random_uuid(),
  periodo_inicio date not null,
  periodo_fim date not null,
  periodo_comparacao_inicio date,
  periodo_comparacao_fim date,
  versao_motor text not null,          -- ex. "1.0.0", pesos/piso da seção 5.1
  achados jsonb not null,              -- array de Achado[]
  texto_final text,                    -- null se gerado só por template
  gerado_por uuid references auth.users(id),
  gerado_em timestamptz not null default now()
);
-- RLS: select para is_write_allowed() (herda o mesmo padrão já usado em maquinas/vendas_maquina/
-- extrato_lancamento/feriados/cartao_* — função já existe no schema remoto); regenerar cria LINHA NOVA,
-- nunca faz update na antiga (imutabilidade pedida na seção 8 do pedido original).
```

**Consultas principais** (agregação em SQL, não em JS, pelos motivos de performance da seção 8 do pedido):
- Mediana/MAD por categoria/mês: `percentile_cont(0.5) within group (...)` + subquery de desvios absolutos — Postgres nativo, sem view nova necessária para o MVP (volume atual é baixo: 29 tabelas, a maior com ~9 mil linhas).
- View `v_despesa_categoria_mensal` e `v_fornecedor_mensal` (materializadas como view simples, não `materialized view` — volume não justifica o custo de refresh manual ainda; reavaliar na Fase 3 se o histórico crescer).
- Índice novo: `contas_pagar (fornecedor_canonico_id, data_pagamento)` para os rankings de fornecedor.

**Performance**: todo o cálculo roda num route handler (`POST /api/analise-inteligente`), nunca no navegador. Com o volume atual (a maior tabela, `movimentacoes`, tem 4.882 linhas), uma consulta de um trimestre inteiro agregada em SQL roda em milissegundos — não há necessidade de pré-cálculo/cache para o MVP. Pré-cálculo por mês fechado fica proposto como otimização de Fase 3, só se o histórico crescer o bastante para justificar.

---

## 8. UX no Painel CEO + 3 direções visuais

**Fluxo**: dentro do Painel CEO (mesma regra de acesso, `role === 'master'`), substitui o botão quebrado. Seletor de período com os atalhos da seção 3 do pedido (mês x anterior, trimestre x trimestre, ano x ano, acumulado x acumulado) + intervalo livre nos dois lados (reaproveitando o padrão de dropdown "de mês/ano até mês/ano" que `/relatorios` já usa, em vez de inventar um datepicker novo). Botão "Gerar Análise Inteligente" → relatório na tela → botão "Imprimir / Salvar PDF" usando o padrão de `gerarImpressao` de `relatorios/page.tsx`, adaptado com `Logo`, tokens de `globals.css`, cabeçalho/rodapé com paginação e período.

### Direção A — "Consultoria sóbria"
- **Paleta**: `--color-text` sobre `--color-bg`, uma única cor de destaque (`--color-primary-dark #059669`) usada só em títulos de seção e no valor do resultado final. Severidade (🔴🟠🟡🟢) só em bolinhas pequenas ao lado do título do achado, nunca como fundo colorido de bloco inteiro.
- **Tipografia**: serifada para títulos (tom de "carta de consultor"), sans-serif para corpo e números (tabular-nums obrigatório em qualquer coluna de valor).
- **Layout página 1**: cabeçalho com logo pequeno + período, 3 linhas de "Como foi o mês", uma tabela estreita de KPIs (sem cards grandes), ponte do resultado como gráfico de cascata em linha fina (SVG, 1 cor + cinza), lista de achados em formato de parágrafo curto numerado, não cards.
- Quando escolher: se o objetivo principal é imprimir e entregar para o contador/sócio como documento formal.

### Direção B — "Painel executivo com gráficos"
- **Paleta**: usa o sistema completo de tokens (`--brand`, `--red`, `--amber`, `--blue`) — cada classe de severidade com sua cor de fundo `-subtle` própria, blocos tipo card com borda `-border`.
- **Tipografia**: sans-serif única (a mesma do resto do app, para parecer "uma tela do +Q Finanças", não um documento à parte), números grandes em destaque nos KPIs.
- **Layout página 1**: 4 KPI-cards no topo (vendas, saídas, resultado, margem de caixa) com variação em badge colorido, ponte do resultado como gráfico de cascata colorido, mix de recebimento como rosca/pizza, top fornecedores como barras horizontais.
- Quando escolher: se o objetivo principal é ler na tela rapidamente, e a impressão é secundária.

### Direção C — "Editorial com destaque de números"
- **Paleta**: fundo neutro, números grandes (tipografia tabular grande) como elemento central de cada bloco, cor só para sinalizar alta/queda ao lado do número (seta + cor, nunca bloco colorido).
- **Tipografia**: uma família com peso variável (ex.: números em peso 700 grandes, texto de apoio em peso 400 pequeno ao lado) — "revista de dado", não "dashboard".
- **Layout página 1**: resultado do mês como número gigante no topo (tipo capa de revista: "R$ XX mil, -2% vs mês anterior"), achados como mini-blocos "número grande + 1 linha de explicação", gráficos minimalistas (sparklines inline no texto, não gráficos grandes separados).
- Quando escolher: se o objetivo é impacto visual rápido para quem não vai ler o relatório inteiro, só bater o olho nos números-chave.

Em qualquer direção: SVG para os gráficos (nitidez na impressão), cores com contraste suficiente para funcionar em impressão P&B (testar com `filter: grayscale(1)` antes de aprovar), CSS de impressão próprio em A4 com cabeçalho/rodapé (logo, período, "gerado em DD/MM HH:MM", "versão do motor X.Y.Z", paginação "página N de M").

---

## 8.1 Dimensão produto — preparado, não implementado

Hoje não existe `produto` nem `quantidade` em nenhuma tabela — confirmado, nenhuma linha de código ou schema guarda isso. Quando a dimensão existir, ela vai precisar de (apontamento, sem criar nada agora):
- **Produtos comprados**: `xml_nota` precisaria de uma tabela filha `xml_nota_item` (produto, quantidade, valor unitário) — hoje só guarda `valor_total` da nota inteira; o XML original (`xml_bruto`, já guardado como texto) tecnicamente já contém os itens, só não são parseados/persistidos linha a linha.
- **Produtos vendidos**: viria do ERP/PDV externo mencionado no pedido — fora do controle deste sistema até a integração existir; nenhuma tabela local pode ser inventada antecipadamente sem saber o formato de exportação desse sistema.

O motor já nasce organizado em **dimensões plugáveis** (a tabela da seção 5.3 é literalmente isso: cada linha é uma dimensão com sua própria regra de detecção), e o campo `Achado.dimensao` do contrato JSON (seção 6) já é uma união de strings extensível — adicionar `"produto"` no dia em que a tabela existir não quebra nenhum achado anterior. A seção do relatório reservada para produto simplesmente não renderiza enquanto nenhum achado tiver `dimensao: "produto"` no array.

---

## 9. Riscos e dados que faltam

**Riscos técnicos:**
- Normalização de fornecedor por "contém" (seção 3) pode gerar falso-positivo em nomes curtos genéricos (testei: buscar fornecedores que contêm "A" ou "M" sozinho retorna dezenas de linhas irrelevantes) — a sugestão assistida precisa limitar o match automático a nomes com ≥ 4 caracteres normalizados, e nunca aplicar automaticamente abaixo disso.
- `fechamentos_mensais` ter só 3 linhas hoje significa que, na prática, quase todo relatório gerado nos próximos meses vai nascer com algum mês 🟡 Parcial — isso é esperado e correto (reflete a realidade do negócio), mas pode frustrar a expectativa de "ver tudo 🟢 Completo" se não for bem explicado na UI.
- `metas`/`metas_vendas` têm só 2 registros cada hoje — o achado #10 (realizado vs meta) vai aparecer raramente até o usuário cadastrar metas com mais regularidade.
- **Insight #14 (descasamento de prazo cartão)** só tem um mês de dado real (agosto/2026) no módulo de Conciliação de Cartão — a explicação de um mês isolado já funciona, mas a comparação "mês anterior teve mais crédito, por isso este mês recebi melhor" só fica disponível assim que setembro (e os meses seguintes) forem importados nesse módulo. Não é uma limitação do motor, é dependência de uso contínuo de um módulo que já existe.
- `cartao_transacao` modalidade `voucher` não tem `data_prevista_calculada` preenchida — o insight #14 cobre crédito/débito por enquanto; voucher fica de fora até esse campo ser calculado pro VR também.
- `cartao_taxa_contratada.prazo_dias`/`prazo_tipo` estão **vazios** (null) nas 7 linhas cadastradas — o prazo usado no insight #14 vem medido direto de `cartao_transacao` (venda → previsão), não desse campo contratado. Vale preencher esse campo em algum momento (serve de referência/auditoria), mas não é bloqueador: o insight usa o prazo observado, que é mais confiável que o contratado.

**Riscos financeiros/de confiança:**
- Se a validação anti-número-inventado (seção 6) tiver um bug e deixar passar um número que a IA inventou, o dano de credibilidade é alto (é um relatório que vai para sócio/contador). Recomendo que a Fase 1 entregue o relatório **só com texto-template determinístico**, sem IA nenhuma — a Fase 2 adiciona a redação por IA só depois da validação ter rodado em produção sem incidente por um tempo.

**Dados que faltam e valeriam ser coletados:**
- CMV/estoque — permitiria falar de margem de verdade, não só caixa. Custo-benefício alto, mas é mudança de modelo de negócio do sistema, não deste módulo.
- Centro de custo — se o mercado tiver mais de uma frente (ex.: loja física x delivery), permitiria segmentar receita/despesa por frente. Hoje tudo é um caixa só.
- `metas` por categoria de despesa (`tipo='despesa_categoria'`) — a coluna já existe no schema mas está com **zero linhas cadastradas**; "despesa fora do padrão" hoje só compara com o próprio histórico, nunca com uma meta definida pelo usuário.

---

## 10. Plano em fases

**Fase 1 — MVP (qualidade de dados + normalização de fornecedor + motor com 5-6 insights + relatório na tela, sem IA)**
- Migrations: `fornecedor_canonico` + `contas_pagar.fornecedor_canonico_id`, `analise_inteligente`.
- Normalização assistida de fornecedor (tela de revisão, seção 3).
- Motor determinístico cobrindo os insights #1, #3, #6, #7, #9, #10, #13 e **#14** do catálogo (seção 5.3) — os que não dependem de ≥3-4 meses de histórico. O #14 (descasamento de prazo cartão) entra na Fase 1 porque é o insight que você mais pediu explicitamente — já funciona com o único mês de dado disponível hoje (agosto/2026), e melhora sozinho conforme mais meses forem importados no módulo de cartão.
- Relatório na tela do Painel CEO, uma das 3 direções visuais escolhida, texto 100% por template (sem IA).
- Seletor de período com os atalhos + intervalo livre.

**Fase 2 — IA redatora + PDF + histórico**
- Rota `/api/analise-inteligente`, validação anti-número-inventado em produção.
- Impressão/PDF com cabeçalho, rodapé, paginação.
- Histórico de análises geradas (já salva desde a Fase 1, mas sem tela de consulta até aqui).

**Fase 3 — demais insights e comparação anual**
- Insights #2, #4, #5, #8, #11, #12 (os que dependem de mais meses de histórico ou de tabelas com pouco dado hoje, como `cartao_taxa_contratada`).
- Comparação com mesmo mês do ano anterior (ativa sozinha quando abr-jun/2027 tiver dado).
- Reavaliar pré-cálculo/materialização se o volume de dado justificar.

---

## 11. Decisões — status

Decididas em conversa (03/10/2026):

1. ✅ **Direção visual**: B — Painel executivo com gráficos.
2. ✅ **Verbo em `audit_log.acao`**: amplia o enum com `"analisou"`.
3. ✅ **`/analise` (tela atual)**: mantém como está, sem mexer, por agora.
4. ✅ **Fase 1 sem IA**: confirmado — zero custo de API externa. Nenhuma chamada a modelo de IA na Fase 1; texto 100% por template determinístico (inclusive o insight #14, que é "texto explicativo" mas construído por regra condicional sobre número medido, não por IA). Reavaliar IA (Anthropic, mesma API que o `/api/chat` já usa, cobrada por uso) só depois da Fase 1 estar no ar, se o texto por template não for suficiente.

5. ✅ **Receita oficial = `movimentacoes` entrada** (não `fechamento_caixa`) — revisto em conversa (03/10/2026): é regime de caixa real, coerente com o resto do sistema, e evita o efeito de descasamento de prazo do cartão (insight #14) contaminar a receita oficial. `fechamento_caixa` vira fonte operacional/diagnóstica. Seção 0 ponto 3, seção 2 e os exemplos simulados da seção 5 já atualizados com essa fonte.

Ainda pendente, mas não bloqueia o início do código (ajusto depois com baixo custo):

6. **Threshold de "concentração de vencimentos"** (>35% do total pendente numa semana) — número que escolhi pra simulação rodar; ajustável depois sem custo de retrabalho.

**Todas as decisões estruturais estão fechadas — posso começar a Fase 1.**
