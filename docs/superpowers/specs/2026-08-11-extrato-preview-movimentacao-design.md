# Extrato → prévia de Movimentação (categorias reais + resumo diário)

Status: implementado.

## Contexto

A Fase 1 (`/extrato`) já existe: upload de `.ofx`, motor de regras (`aplicarRegras`), classificação manual, criação de regra a partir de uma classificação, reprocessamento. Tudo isolado em tabelas de staging (`extrato_conta`, `extrato_importacao`, `extrato_lancamento`, `extrato_regra`), sem nenhuma escrita em `movimentacoes`.

O objetivo de longo prazo do usuário: subir o extrato bancário e ter os lançamentos classificados automaticamente entrando em Movimentações, sem lançamento manual — hoje pix e cartão são lançados manualmente no sistema real (Fechamento de Caixa só lança dinheiro automaticamente). Antes de ligar essa automação de verdade, o usuário quer validar por um tempo, olhando uma simulação fiel dentro do `/extrato`, comparando categorias e somas contra o que ele mesmo já espera do fluxo de caixa diário.

Esta spec cobre **apenas** a evolução da tela de staging para essa simulação. **Não inclui** escrever em `movimentacoes` — isso é uma decisão futura e separada, fora de escopo aqui.

## Objetivo

Fazer o `/extrato` mostrar, para cada lançamento classificado, exatamente o que ele viraria como movimentação real (tipo, categoria real, data, valor), e um resumo somado por categoria agrupado por dia — para o usuário validar visualmente a automação antes de decidir ligá-la de verdade.

## Design

### 1. Categorias reais em vez da lista genérica

- `CATEGORIAS_INICIAIS` (lista fixa hardcoded) é substituída por leitura das tabelas reais `categorias_entrada` e `categorias_saida` (`select nome, id from ... where ativo = true`). Leitura apenas — nenhuma escrita nessas tabelas.
- O campo `categoria` em `extrato_lancamento`/`extrato_regra` continua texto livre (sem migration nova); só passa a ser preenchido exclusivamente a partir dos nomes reais.
- **Tipo (Entrada/Saída)** é sempre derivado do sinal do `valor` do lançamento (`valor >= 0` → entrada, `valor < 0` → saída) — nunca armazenado, é um campo calculado na UI.
- Ao classificar manualmente um lançamento, o campo de categoria só oferece as categorias reais da direção correspondente ao sinal do valor daquele lançamento (uma entrada só mostra categorias de `categorias_entrada`, uma saída só de `categorias_saida`).
- Ao criar/editar uma regra, o campo de categoria mostra a lista combinada (entrada + saída), já que uma regra pode em tese casar valores de ambos os sinais.

### 2. Prévia de Movimentação por lançamento

- Cada lançamento classificado exibe, de forma clara, o que "entraria" como movimentação: `[Entrada|Saída] · [categoria real] · [data] · [valor formatado]`.
- Lançamentos ainda não classificados continuam com a etiqueta "pendente" já existente (é exatamente o mecanismo de "sinalização de não foi possível atribuir" que o usuário descreveu) — nenhuma mudança necessária aqui, já está implementado.

### 3. Resumo somado por categoria, agrupado por dia

- Novo painel (dentro da aba Lançamentos, abaixo dos contadores existentes) mostrando, por dia, os totais por categoria dos lançamentos classificados: quantidade e soma do valor.
- Agrupamento respeita o filtro de conta já existente na tela.
- Objetivo: permitir ao usuário bater o olho no fluxo de caixa diário simulado, mês a mês, e comparar contra o que ele já espera/lança manualmente hoje.

## Fora de escopo (explicitamente, por decisão do usuário)

- Não escreve em `movimentacoes`. Nenhum botão "lançar de verdade" nesta etapa.
- Não faz reconciliação/match contra movimentações já existentes no sistema real — o usuário confirmou que isso não é necessário; o foco é o fluxo daqui pra frente, não o histórico.
- Não altera `categorias_entrada`/`categorias_saida` — só leitura.
- Não adiciona colunas/migrations em tabelas existentes nem nas tabelas de staging já criadas.

## Passo prático seguinte (fora desta implementação)

O usuário vai trazer um `.ofx` real do Santander para ver como as descrições brutas realmente vêm do banco (provavelmente abreviadas/codificadas), e a partir daí desenhar as regras reais linha por linha dentro do `/extrato` já construído. Essa spec deixa a tela pronta para receber esse trabalho.
