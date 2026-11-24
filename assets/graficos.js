// =====================================================================
//  GRÁFICOS OPERACIONAIS — Sistema Integrado USA
//  Fonte de dados: Firestore  app_data/dados  (list)
//                             app_data/cores  (map)        ← Gestor de Cores
//                             app_data/config (processos)  ← Cadastros
//  Regras por processo: assets/graficos-config.js
//  Utilidades comuns:   assets/usa-core.js
// =====================================================================
(function () {
    'use strict';

    const {
        CFG, pad, norm, esc, fmt, num, plural,
        hojeISO, somarDiasISO, isoParaBR, diaDaSemana, horaDoRegistro, horasDaRegra, horasDevidas, textoTurno, aoMudarTurnos,
        configDoProcesso, filtrarRegistros, operacaoAtiva, nomeDaFrota,
        lerUI, salvarUI, conectar, gerarPrint, assinaturaDoDiaOperacional
    } = window.USA;

    // Baixa só o dia operacional escolhido (dia + madrugada seguinte)
    const garantirDados = assinaturaDoDiaOperacional(
        (lista) => {
            estado.dados = lista;
            setStatus('online', `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
            agendarRender();
        },
        () => setStatus('erro', 'Sem conexão')
    );

    const UI_KEY = 'usa_graficos_ui';
    const COR_BARRA = '#1e7a46';
    const $ = (id) => document.getElementById(id);

    const estado = {
        dados: null,              // null = ainda carregando
        cores: {},
        processosCadastro: [],
        cadastroCarregado: false,
        charts: [],
        renderPendente: false
    };

    const ICONES = {
        ok:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        parcial: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>',
        parado:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
        neutro:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12"/></svg>'
    };

    // ------------------------------------------------------------------
    //  Processos — o menu mostra SOMENTE o que está em Cadastros
    // ------------------------------------------------------------------
    function listaDeProcessos() {
        const vistos = new Set();
        const lista = [];
        estado.processosCadastro.forEach((n) => {
            const k = norm(n);
            if (k && !vistos.has(k)) { vistos.add(k); lista.push(k); }
        });
        return lista;
    }

    function montarSelectProcessos() {
        const sel = $('select-proc');
        const atual = sel.value || sel.dataset.inicial;
        // Enquanto o Cadastro não carrega, mostra só o processo inicial
        const lista = estado.cadastroCarregado ? listaDeProcessos() : (atual ? [atual] : []);

        const assinatura = lista.join('|');
        if (sel.dataset.assinatura === assinatura) return;
        sel.dataset.assinatura = assinatura;

        if (!lista.length) {
            sel.innerHTML = '<option value="">Nenhum processo cadastrado</option>';
            sel.value = '';
            return;
        }
        sel.innerHTML = lista.map((n) => {
            const c = configDoProcesso(n);
            return `<option value="${esc(n)}">${c.icone} ${esc(n)}</option>`;
        }).join('');
        sel.value = lista.includes(atual) ? atual : lista[0];
    }

    // ------------------------------------------------------------------
    //  Cores
    // ------------------------------------------------------------------
    const corDoMotivo = (chave) => window.USA.corDoMotivo(chave, estado.cores);
    function chaveDoMotivo(r, cfg) {
        if (norm(r.status) === 'PRODUTIVO') return 'PRODUTIVO';
        const m = norm(r.motivo);
        if (!m || m === 'NULL') return 'SEM INFORMAÇÃO';
        if (cfg.agruparMotivos && !estado.cores[m]) {
            const grupo = CFG.GRUPOS_MOTIVO.find((g) => g.termos.some((t) => m.includes(t)));
            if (grupo) return grupo.nome;
        }
        return m;
    }

    // ------------------------------------------------------------------
    //  Agregação (sem DOM)
    // ------------------------------------------------------------------
    function agregar(registros, cfg, horas) {
        const res = {
            total: 0, horasProd: 0, nRegistros: registros.length,
            porOperacao: {}, linhas: new Map(), frotas: new Map(),
            motivos: new Map(),        // chave → cor
            horasPorMotivo: new Map()  // chave → nº de horas (todas as frotas)
        };

        registros.forEach((r) => {
            const v = num(r.qtd);
            const produtivo = norm(r.status) === 'PRODUTIVO';
            const faz = norm(r.fazenda || r.faz) || 'N/A';
            const oper = norm(r.oper) || 'N/A';
            const frota = nomeDaFrota(r.eq);
            const hora = pad(horaDoRegistro(r));
            const operAtiva = operacaoAtiva(oper);

            res.total += v;
            if (produtivo) res.horasProd++;
            if (v > 0 && operAtiva) res.porOperacao[oper] = (res.porOperacao[oper] || 0) + v;

            const kLinha = `${frota}|${faz}|${oper}`;
            const linha = res.linhas.get(kLinha) || { frota, faz, oper, total: 0, hP: 0 };
            linha.total += v;
            if (produtivo) linha.hP++;
            res.linhas.set(kLinha, linha);

            let f = res.frotas.get(frota);
            if (!f) {
                f = { id: frota, eqOriginal: norm(r.eq), ultimaFaz: 'N/A', ops: new Set(), total: 0, hP: 0, nHoras: 0,
                      porHora: {}, corHora: {}, motivoHora: {}, idHora: {}, paradas: new Map(), obs: [] };
                horas.forEach((h) => { f.porHora[h] = 0; });
                res.frotas.set(frota, f);
            }
            if (faz !== 'N/A') f.ultimaFaz = faz;
            f.total += v;
            f.nHoras++;
            if (produtivo) {
                f.hP++;
                if (operAtiva) f.ops.add(oper);
            }
            if (hora in f.porHora) f.porHora[hora] += v;
            if (r.obs && String(r.obs).trim()) f.obs.push({ hora, texto: String(r.obs).trim() });

            const chave = chaveDoMotivo(r, cfg);
            const cor = corDoMotivo(chave);
            res.motivos.set(chave, cor);
            res.horasPorMotivo.set(chave, (res.horasPorMotivo.get(chave) || 0) + 1);
            f.corHora[hora] = cor;
            f.motivoHora[hora] = chave;
            if (r.id) f.idHora[hora] = r.id;
            if (chave !== 'PRODUTIVO') f.paradas.set(chave, (f.paradas.get(chave) || 0) + 1);
        });

        return res;
    }

    function principalParada(mapa) {
        let melhor = null;
        mapa.forEach((h, k) => {
            if (k !== 'PRODUTIVO' && (!melhor || h > melhor[1])) melhor = [k, h];
        });
        return melhor;
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    function unidadeHTML(cfg) {
        return cfg.unidade ? `<small>${esc(cfg.unidade)}</small>` : '';
    }

    function renderStatus(res, proc) {
        const frotas = Array.from(res.frotas.values());
        const produzindo = frotas.filter((f) => f.total > 0).length;
        const parada = principalParada(res.horasPorMotivo);
        const txtParada = parada ? `Principal motivo de parada: ${parada[0]} (${parada[1]}h)` : '';

        let tipo, titulo, sub;
        if (!res.nRegistros) {
            tipo = 'neutro'; titulo = 'Sem apontamentos';
            sub = `Nenhum registro de ${proc} neste dia operacional.`;
        } else if (produzindo === frotas.length) {
            tipo = 'ok'; titulo = 'Todas as frotas produzindo';
            sub = `${produzindo} de ${frotas.length} frotas com produção` + (parada ? ` · ${txtParada}` : '');
        } else if (produzindo > 0) {
            tipo = 'parcial'; titulo = `${produzindo} de ${frotas.length} frotas produzindo`;
            sub = txtParada;
        } else {
            tipo = 'parado'; titulo = 'Nenhuma frota produzindo';
            sub = `${plural(frotas.length, 'frota apontada', 'frotas apontadas')}` + (parada ? ` · ${txtParada}` : '');
        }

        $('status-dia').className = `status-dia ${tipo}`;
        $('status-icone').innerHTML = ICONES[tipo];
        $('status-titulo').textContent = titulo;
        $('status-sub').textContent = sub;
    }

    function renderKPIs(res, cfg) {
        const ops = Object.keys(res.porOperacao).sort();
        const un = unidadeHTML(cfg);

        $('v_total').innerHTML = `${fmt(res.total, cfg.decimais)}${un}`;
        $('v_total_det').innerHTML = ops.length > 1
            ? ops.map((op) => `${esc(op)}: <b>${fmt(res.porOperacao[op], cfg.decimais)}</b>`).join(' · ')
            : esc(ops[0] || 'Sem produção');

        const nFrotas = res.frotas.size;
        $('v_efici').textContent = res.nRegistros ? `${Math.round(res.horasProd / res.nRegistros * 100)}%` : '0%';
        $('v_efici_det').innerHTML = `<b>${res.horasProd}</b> de ${plural(res.nRegistros, 'hora apontada', 'horas apontadas')}`;
        $('v_media_h').innerHTML = `${fmt(res.horasProd ? res.total / res.horasProd : 0, cfg.decimais)}${un}`;
        $('v_media_eq').innerHTML = `${fmt(nFrotas ? res.total / nFrotas : 0, cfg.decimais)}${un}`;
        $('v_media_eq_det').textContent = plural(nFrotas, 'frota', 'frotas');
    }

    function renderTabela(res, cfg) {
        const linhas = Array.from(res.linhas.values())
            .filter((l) => l.total > 0)
            .sort((a, b) => a.frota.localeCompare(b.frota) || a.faz.localeCompare(b.faz) || a.oper.localeCompare(b.oper));

        $('corpo_tab').innerHTML = linhas.length
            ? linhas.map((l) => {
                const destaque = CFG.FROTAS_DESTAQUE.some((t) => l.frota.includes(t)) ? ' class="linha-especial"' : '';
                return `<tr${destaque}>
                    <td class="frota-cel">${esc(l.frota)}</td>
                    <td>${esc(l.faz)}</td>
                    <td>${esc(l.oper)}</td>
                    <td class="num">${fmt(l.total, cfg.decimais)}</td>
                    <td class="num rend">${fmt(l.total / (l.hP || 1), cfg.decimais)}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="5" class="vazio">Nenhuma produção registrada para este processo neste dia.</td></tr>`;
    }

    // Legenda de CADA equipamento: horas por status/motivo só daquela frota
    // devidas = horas do turno que já chegaram (as futuras não contam como "sem apontamento")
    function htmlLegendaFrota(f, horas, devidas) {
        const porMotivo = new Map();
        horas.forEach((h) => {
            const m = f.motivoHora[h];
            if (m) porMotivo.set(m, (porMotivo.get(m) || 0) + 1);
        });
        const semApont = horas.slice(0, devidas).filter((h) => !f.corHora[h]).length;
        const chips = Array.from(porMotivo.entries())
            .sort((a, b) => (a[0] === 'PRODUTIVO' ? -1 : b[0] === 'PRODUTIVO' ? 1 : b[1] - a[1] || a[0].localeCompare(b[0])))
            .map(([m, n]) => `<span class="chip"><span class="cor" style="background:${esc(corDoMotivo(m))}"></span>${esc(m)} <b>${n}h</b></span>`);
        if (semApont) chips.push(`<span class="chip chip-vazio"><span class="cor sem-apont"></span>SEM APONTAMENTO <b>${semApont}h</b></span>`);
        return `<div class="legenda-frota">${chips.join('')}</div>`;
    }

    function destruirGraficos() {
        estado.charts.forEach((c) => c.destroy());
        estado.charts = [];
    }

    // Link para lançar/editar a hora no Banco de Dados (volta para cá ao terminar)
    function linkLancamento(f, h, cfg, dataISO) {
        const p = new URLSearchParams({ dia: dataISO, eq: f.eqOriginal, hora: h, proc: cfg.nome, voltar: '1' });
        if (f.idHora[h]) p.set('editar', f.idHora[h]);
        return `Banco_dados_PPT.html?${p.toString()}`;
    }

    function htmlFrota(f, i, cfg, horas, dataISO) {
        const produzindo = f.total > 0;
        const ops = Array.from(f.ops).join(' + ');
        const badge = produzindo
            ? `<span class="badge produzindo" title="${esc(ops)}">${esc(ops || 'Produzindo')}</span>`
            : `<span class="badge parado">Parado</span>`;

        const paradasOrd = Array.from(f.paradas.entries()).sort((a, b) => b[1] - a[1]);
        const corpo = produzindo
            ? `<div class="grafico-box"><canvas data-idx="${i}"></canvas></div>`
            : `<div class="sem-producao"><span>Sem produção no turno</span>${paradasOrd.length
                ? `<span>— parado principalmente por <b>${esc(paradasOrd[0][0])}</b> (${paradasOrd[0][1]}h)</span>` : ''}</div>`;

        const devidas = horasDevidas(cfg, dataISO);
        const fatias = horas.map((h, idx) => {
            const cor = f.corHora[h];
            const futura = !cor && idx >= devidas;
            const dica = cor
                ? `${h}h · ${f.motivoHora[h]}${f.porHora[h] ? ` · ${fmt(f.porHora[h], cfg.decimais)}` : ''} — clique para editar`
                : futura ? `${h}h · hora ainda não chegou` : `${h}h · sem apontamento — clique para lançar`;
            const href = esc(linkLancamento(f, h, cfg, dataISO));
            if (cor) return `<a class="fatia" href="${href}" style="background:${esc(cor)}" title="${esc(dica)}"></a>`;
            return `<a class="fatia ${futura ? 'futura' : 'sem-apont'}" href="${href}" title="${esc(dica)}"></a>`;
        }).join('');

        return `
            <article class="card frota">
                <div class="frota-cab">
                    <div>
                        <div class="frota-id">${esc(f.id)}</div>
                        <div class="frota-faz">${esc(f.ultimaFaz)}</div>
                    </div>
                    <div class="frota-dir">
                        <div class="frota-total">${fmt(f.total, cfg.decimais)}${unidadeHTML(cfg)}</div>
                        ${badge}
                    </div>
                </div>
                <div class="frota-meta">
                    <span title="Horas produtivas ÷ horas apontadas">Eficiência <b>${f.nHoras ? Math.round(f.hP / f.nHoras * 100) : 0}%</b> <small class="meta-det">(${f.hP} de ${plural(f.nHoras, 'h apontada', 'h apontadas')})</small></span>
                    <span>Rend./h <b>${fmt(f.hP ? f.total / f.hP : 0, cfg.decimais)}</b></span>                </div>
                ${corpo}
                <div class="timeline">${fatias}</div>
                <div class="labels-hora">${horas.map((h) => `<span>${h}</span>`).join('')}</div>
                ${htmlLegendaFrota(f, horas, devidas)}
                ${f.obs.length ? `<div class="obs">${f.obs.map((o) =>
                    `<div class="obs-item"><b>${o.hora}h</b> ${esc(o.texto)}</div>`).join('')}</div>` : ''}
            </article>`;
    }

    function renderFrotas(res, cfg, horas, dataISO) {
        destruirGraficos();
        const grid = $('grid_eq');
        // Frotas produzindo primeiro, depois por número
        const frotas = Array.from(res.frotas.values())
            .sort((a, b) => (b.total > 0) - (a.total > 0) || a.id.localeCompare(b.id, 'pt-BR', { numeric: true }));
        $('cont-frotas').textContent = plural(frotas.length, 'frota', 'frotas');

        if (!frotas.length) {
            grid.innerHTML = `<div class="card vazio">Nenhuma frota apontada neste dia operacional.</div>`;
            return;
        }

        grid.innerHTML = frotas.map((f, i) => htmlFrota(f, i, cfg, horas, dataISO)).join('');
        grid.querySelectorAll('canvas[data-idx]').forEach((canvas) => {
            const f = frotas[Number(canvas.dataset.idx)];
            const aoClicar = (h) => { location.href = linkLancamento(f, h, cfg, dataISO); };
            estado.charts.push(desenharGrafico(canvas, horas.map((h) => f.porHora[h]), horas, cfg, aoClicar));
        });
    }

    function desenharGrafico(canvas, valores, horas, cfg, aoClicar) {
        const max = Math.max(0, ...valores);
        return new Chart(canvas, {
            type: 'bar',
            data: {
                labels: horas,
                datasets: [{
                    data: valores,
                    backgroundColor: COR_BARRA,
                    hoverBackgroundColor: '#145c33',
                    borderRadius: 3,
                    categoryPercentage: 1,
                    barPercentage: 0.82
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                layout: { padding: { top: 16, left: 0, right: 0, bottom: 0 } },
                // clicar numa barra abre a hora no Banco de Dados
                onClick: (evt, itens) => { if (itens.length && aoClicar) aoClicar(horas[itens[0].index]); },
                onHover: (evt, itens) => { evt.native.target.style.cursor = itens.length ? 'pointer' : 'default'; },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        displayColors: false,
                        callbacks: {
                            title: (it) => `${it[0].label}h`,
                            label: (it) => `${fmt(it.raw, cfg.decimais)} ${cfg.unidade}`
                        }
                    },
                    datalabels: {
                        display: 'auto', anchor: 'end', align: 'top', offset: 1, clip: false,
                        formatter: (v) => (v > 0 ? fmt(v, cfg.decimais) : ''),
                        font: { family: 'Inter, Segoe UI, sans-serif', size: 9.5, weight: '600' },
                        color: '#374151'
                    }
                },
                scales: {
                    x: { display: false, grid: { display: false } },
                    y: { display: false, beginAtZero: true, suggestedMax: max > 0 ? max * 1.15 : 1 }
                }
            }
        });
    }

    function render() {
        estado.renderPendente = false;
        montarSelectProcessos();

        const proc = $('select-proc').value;
        const dataISO = $('filtro-data').value || hojeISO();
        if (garantirDados(dataISO)) estado.dados = null;
        $('ctx-data').textContent = `${diaDaSemana(dataISO)}, ${isoParaBR(dataISO)}`;

        if (!proc) {
            destruirGraficos();
            $('ctx-proc').textContent = 'Gráficos Operacionais';
            $('tag-turno').textContent = '';
            $('status-dia').className = 'status-dia';
            $('status-icone').innerHTML = ICONES.neutro;
            $('status-titulo').textContent = estado.cadastroCarregado ? 'Nenhum processo cadastrado' : 'Carregando…';
            $('status-sub').textContent = estado.cadastroCarregado ? 'Cadastre os processos na aba Cadastros.' : '';
            $('corpo_tab').innerHTML = `<tr><td colspan="5" class="vazio">${estado.cadastroCarregado
                ? 'Nenhum processo cadastrado. Cadastre em Cadastros.' : 'Carregando…'}</td></tr>`;
            $('grid_eq').innerHTML = '';
            return;
        }

        const cfg = configDoProcesso(proc);
        const horas = horasDaRegra(cfg);

        // Estado da UI: URL (links/favoritos) + localStorage (reabrir)
        salvarUI(UI_KEY, { processo: proc, data: dataISO });
        const url = new URL(location.href);
        url.searchParams.set('proc', proc);
        history.replaceState(null, '', url);

        $('ctx-proc').textContent = `${cfg.icone} ${proc}`;
        $('tag-turno').textContent = textoTurno(cfg);
        document.title = `Gráficos · ${proc}`;

        if (estado.dados === null) {
            $('status-titulo').textContent = 'Carregando…';
            $('corpo_tab').innerHTML = `<tr><td colspan="5" class="vazio">Carregando dados…</td></tr>`;
            return;
        }

        const registros = filtrarRegistros(estado.dados, cfg, dataISO);
        const res = agregar(registros, cfg, horas);
        renderStatus(res, proc);
        renderKPIs(res, cfg);
        renderTabela(res, cfg);
        renderFrotas(res, cfg, horas, dataISO);
    }

    // Junta várias atualizações seguidas (dados + cores + cadastro) num único render
    function agendarRender() {
        if (estado.renderPendente) return;
        estado.renderPendente = true;
        requestAnimationFrame(render);
    }

    async function copiarPrint() {
        const btn = $('btnPrint');
        if (btn.disabled) return;
        const original = btn.innerHTML;
        const tituloOriginal = btn.title;
        btn.disabled = true;
        btn.innerHTML = '…';
        const r = await gerarPrint($('area-print'), `Graficos_${$('select-proc').value}_${$('filtro-data').value}`, '#f3f4f6');
        btn.innerHTML = { copiado: '✓', baixado: '↓', erro: '!' }[r];
        btn.title = { copiado: 'Copiado!', baixado: 'Imagem baixada', erro: 'Erro ao gerar print' }[r];
        setTimeout(() => { btn.innerHTML = original; btn.title = tituloOriginal; btn.disabled = false; }, 1500);
    }

    function setStatus(classe, texto) {
        $('status-conexao').className = `pill status-conexao ${classe}`;
        $('status-texto').textContent = texto;
    }

    // ------------------------------------------------------------------
    //  Inicialização
    // ------------------------------------------------------------------
    function iniciar() {
        Chart.register(ChartDataLabels);

        const params = new URLSearchParams(location.search);
        const ui = lerUI(UI_KEY);
        const sel = $('select-proc');
        sel.dataset.inicial = norm(params.get('proc') || ui.processo || CFG.PROCESSOS[0].nome);
        $('filtro-data').value = params.get('data') || ui.data || hojeISO();

        const mudarDia = (n) => { $('filtro-data').value = somarDiasISO($('filtro-data').value || hojeISO(), n); render(); };
        sel.addEventListener('change', render);
        $('filtro-data').addEventListener('change', render);
        $('btn-dia-ant').addEventListener('click', () => mudarDia(-1));
        $('btn-dia-prox').addEventListener('click', () => mudarDia(1));
        $('btn-hoje').addEventListener('click', () => { $('filtro-data').value = hojeISO(); render(); });
        $('btnPrint').addEventListener('click', copiarPrint);

        conectar({
            onCores: (mapa) => { estado.cores = mapa; agendarRender(); },
            onConfig: (cfg) => {
                estado.processosCadastro = cfg.processos || [];
                estado.cadastroCarregado = true;
                agendarRender();
            },
            onErro: () => setStatus('erro', 'Sem conexão')
        });
        aoMudarTurnos(agendarRender);   // turno cadastrado em Cadastros → redesenha
        render();      // mostra "Carregando…" e começa a ouvir o dia escolhido
    }

    document.addEventListener('DOMContentLoaded', iniciar);
})();
