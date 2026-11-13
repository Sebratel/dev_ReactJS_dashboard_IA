# Resultados de referência do teste de carga

Medição local (Windows 11, Node 24, gerador e API na mesma máquina), 4 de novembro de 2026. API real com login real,
snapshot sintético de **100 000 linhas**, 59 usuários, heap 1024 MB (o teto do compose). Unidade da taxa: aberturas de
dashboard por segundo (≈ 8 requisições cada). Para comparar antes/depois de uma mudança, não como capacidade absoluta do
servidor (ver "Limites conhecidos do teste" no [README](./README.md)).

| Cenário | Duração | Resultado |
|---|---|---|
| smoke (50 mil linhas) | 30 s | APROVADO: 0 falhas, 0 respostas inesperadas |
| load (1 abertura/s + ruído) | 90 s (o critério vale para 10 min) | APROVADO: 15 req/s, 0 falhas, 0 inesperadas; widgets p95 ≤ 535 ms; RSS 266 → 333 MB |
| stress (1 → 40 aberturas/s e volta a 1) | ~16 min | **Limite entre 2 e 3 aberturas/s**; acima disso a API deixa de aceitar conexões |
| spike (2 → 100 aberturas/s por 2 min) | 5 min | Mesma saturação; sem 5xx, sem queda do processo |
| abuso (1 cliente hostil + tráfego nominal) | 3 min | 0 falhas, 0 inesperadas; corpo de 5 MB recusado com 413; p95 ≤ 675 ms |
| segurança sob carga (`seg_*`) | em todos | Barreiras não cederam: 401/403/404/400 corretos |

## O que a medição mostrou

1. **Capacidade**: uma abertura de dashboard (6 widgets) custa ~400 ms de CPU síncrona num único processo Node (100–200 mil
   linhas). O limite fica em ~2–3 aberturas/s. O uso esperado (≈ 60 pessoas, ~1/s) fica dentro, com folga de 2–3×.
2. **Como degrada**: não há erro 5xx nem queda. O laço de eventos fica ocupado, a fila de conexões enche e o servidor
   passa a **recusar conexões** (`ECONNREFUSED`/`ECONNRESET`); rotas leves (`tree`, `me`, `health`) sofrem junto com as
   consultas porque dividem o mesmo processo (p50 da árvore ~4,7 s no pico).
3. **Recuperação**: no stress com degraus finos, a sonda de `/api/health` voltou ao normal (p95 456 ms → 599 ms). Quando o
   stress começou já acima do limite (primeira tentativa, 5 → 160/s), a latência **não** voltou até o fim (p95 6 s → 15 s):
   saturação profunda demora a drenar.
4. **Memória**: estável, pico de 404 MB de RSS com heap de 1024 MB; sem sinal de vazamento nestes cenários (o `soak` de
   30+ min não foi rodado nesta medição).
5. **Primeiro acesso** após o deploy paga a leitura e descompressão síncrona do snapshot; é medido à parte
   (`primeiroAcessoMs`) e fica fora do p95.

## Caminhos de melhoria (cada um é uma mudança à parte)

- Tirar a agregação dos widgets do laço de eventos principal (`worker_threads`) ou rodar 2+ instâncias do `backend`
  (hoje o bloqueio de guia e a memória da IA ficam em memória do processo, o que exige instância única).
- Cache de resultado de widget por (widget, filtros, versão do snapshot): um dashboard aberto por várias pessoas repete
  as mesmas consultas.
- Limite de requisições simultâneas por usuário e por IP no `backend`, para o excesso virar 429 rápido em vez de
  conexão recusada.
- Repetir `load` completo (10 min) e `soak` com o tamanho real do `installData.data` de produção (`ROWS=`).
