// =====================================================================
//  RESUMO PPT — relatório diário de produção por processo
//  Usa as mesmas regras de dia operacional da página de Gráficos
//  (turno, deduplicação, unidade, casas decimais) em graficos-config.js
// =====================================================================
(function () {
    'use strict';

    const {
        norm, esc, fmt, num, plural,
        hojeISO, somarDiasISO, isoParaBR, diaDaSemana, textoTurno,
        regraDoRegistro, noDiaOperacional, chaveDuplicidade, operacaoAtiva, nomeDaFrota,
        lerUI, salvarUI, gerarPrint, assinaturaDoDiaOperacional, aoMudarTurnos
    } = window.USA;

    const garantirDados = assinaturaDoDiaOperacional(
        (lista) => {
            estado.dados = lista;
            setStatus('online', `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
            agendarRender();
        },
        () => setStatus('erro', 'Sem conexão')
    );

    const UI_KEY = 'usa_resumo_ui';
    const $ = (id) => document.getElementById(id);
    const estado = { dados: null, renderPendente: false };

    // Unifica "FAZ A / SETOR 1", "FAZ A-SETOR 1" → "FAZ A - SETOR 1"
    const normalizarFazenda = (f) => norm(f).replace(/\s*\/\s*/g, ' - ').replace(/\s*-\s*/g, ' - ') || 'N/A';

    // ------------------------------------------------------------------
    //  Cálculo (sem DOM)
    // ------------------------------------------------------------------
    function montarResumo(dados, dataISO) {
        // 1) Registros do dia operacional, cada um com a regra do seu processo
        const doDia = [];
        dados.forEach((r) => {
            const cfg = regraDoRegistro(r.proc);
            if (noDiaOperacional(r, cfg, dataISO)) doDia.push({ r, cfg });
        });

        // 2) Deduplicação só nos processos que pedem
        const dedup = new Map();
        const registros = [];
        doDia.forEach((item) => {
            if (item.cfg.deduplicar) dedup.set(chaveDuplicidade(item.r), item);
            else registros.push(item);
        });
        registros.push(...dedup.values());

        // 3) Agrupamento por processo
        const processos = new Map();
        registros.forEach(({ r, cfg }) => {
            const nome = norm(r.proc) || 'SEM PROCESSO';
            let p = processos.get(nome);
            if (!p) {
                p = { nome, cfg, total: 0, horasProd: 0, nRegistros: 0, porOperacao: {}, linhas: new Map(), frotas: new Map() };
                processos.set(nome, p);
            }

            const v = num(r.qtd);
            const produtivo = norm(r.status) === 'PRODUTIVO';
            const oper = norm(r.oper) || 'N/A';
            const frota = nomeDaFrota(r.eq);

            p.nRegistros++;
            if (produtivo) p.horasProd++;

            const f = p.frotas.get(frota) || { total: 0 };
            p.frotas.set(frota, f);
            const faz = normalizarFazenda(r.fazenda || r.faz);

            if (!operacaoAtiva(oper)) {
                // operação "PARADO": não soma produção, mas é hora apontada (entra na eficiência)
                p.paradasSemOper = p.paradasSemOper || new Map();
                const kp = `${frota}|${faz}`;
                p.paradasSemOper.set(kp, (p.paradasSemOper.get(kp) || 0) + 1);
                return;
            }

            p.total += v;
            f.total += v;
            p.porOperacao[oper] = (p.porOperacao[oper] || 0) + v;

            const k = `${frota}|${faz}|${oper}`;
            const l = p.linhas.get(k) || { frota, faz, oper, total: 0, hP: 0, hApont: 0 };
            l.total += v;
            l.hApont++;
            if (produtivo) l.hP++;
            p.linhas.set(k, l);
        });

        // Horas paradas lançadas com operação "PARADO" vão para a linha da mesma frota + fazenda
        // (a de mais horas, se houver mais de uma operação), para a eficiência refletir a parada.
        processos.forEach((p) => {
            if (!p.paradasSemOper) return;
            p.paradasSemOper.forEach((n, kp) => {
                const alvo = Array.from(p.linhas.values())
                    .filter((l) => `${l.frota}|${l.faz}` === kp)
                    .sort((a, b) => b.hApont - a.hApont)[0];
                if (alvo) alvo.hApont += n;
            });
        });

        // 4) Totais gerais
        const lista = Array.from(processos.values());
        const porUnidade = new Map();
        let frotas = 0, frotasProd = 0, horasProd = 0, nRegistros = 0;
        lista.forEach((p) => {
            if (p.total > 0) porUnidade.set(p.cfg.unidade, (porUnidade.get(p.cfg.unidade) || 0) + p.total);
            p.frotas.forEach((f) => { frotas++; if (f.total > 0) frotasProd++; });
            horasProd += p.horasProd;
            nRegistros += p.nRegistros;
        });

        return {
            comProducao: lista.filter((p) => p.total > 0).sort((a, b) => b.total - a.total),
            semProducao: lista.filter((p) => p.total <= 0).sort((a, b) => a.nome.localeCompare(b.nome)),
            porUnidade, frotas, frotasProd, horasProd, nRegistros
        };
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    const pct = (a, b) => (b ? Math.round(a / b * 100) : 0);

    function renderKPIs(res) {
        const unidades = Array.from(res.porUnidade.entries()).sort((a, b) => b[1] - a[1]);
        const [uPrinc, vPrinc] = unidades[0] || ['HA', 0];
        $('k_total').innerHTML = `${fmt(vPrinc, 1)}<small>${esc(uPrinc)}</small>`;
        $('k_total_det').innerHTML = unidades.length > 1
            ? unidades.slice(1).map(([u, v]) => `+ <b>${fmt(v, 1)}</b> ${esc(u)}`).join(' · ')
            : 'soma de todos os processos';

        const nProc = res.comProducao.length + res.semProducao.length;
        $('k_proc').textContent = String(res.comProducao.length);
        $('k_proc_det').innerHTML = `de <b>${nProc}</b> ${nProc === 1 ? 'processo apontado' : 'processos apontados'}`;

        $('k_frotas').textContent = String(res.frotasProd);
        $('k_frotas_det').innerHTML = `de <b>${res.frotas}</b> ${res.frotas === 1 ? 'frota apontada' : 'frotas apontadas'}`;

        $('k_efici').textContent = `${pct(res.horasProd, res.nRegistros)}%`;
        $('k_efici_det').innerHTML = `<b>${res.horasProd}</b> de ${plural(res.nRegistros, 'hora apontada', 'horas apontadas')}`;
    }

    function htmlProcesso(p) {
        const c = p.cfg;
        const frotas = Array.from(p.frotas.entries());
        const produzindo = frotas.filter(([, f]) => f.total > 0).length;
        const paradas = frotas.filter(([, f]) => f.total <= 0).map(([id]) => id)
            .sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));

        const ops = Object.entries(p.porOperacao).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
        const maxOp = ops.length ? ops[0][1] : 1;

        const linhas = Array.from(p.linhas.values()).filter((l) => l.total > 0)
            .sort((a, b) => a.frota.localeCompare(b.frota, 'pt-BR', { numeric: true }) || a.faz.localeCompare(b.faz) || a.oper.localeCompare(b.oper));

        return `
        <section class="card proc">
            <header class="proc-cab">
                <div>
                    <h3>${c.icone} ${esc(p.nome)}</h3>
                    <div class="proc-meta">
                        <span>${textoTurno(c)}</span>
                        <span>${produzindo} de ${plural(frotas.length, 'frota produzindo', 'frotas produzindo')}</span>
                        <span>Eficiência ${pct(p.horasProd, p.nRegistros)}%</span>
                    </div>
                </div>
                <div class="proc-total">${fmt(p.total, c.decimais)}<small>${esc(c.unidade)}</small></div>
            </header>

            ${ops.length > 1 ? `<div class="ops">${ops.map(([op, v]) => `
                <div class="op">
                    <span class="op-nome" title="${esc(op)}">${esc(op)}</span>
                    <span class="op-barra"><i style="width:${Math.max(2, v / maxOp * 100).toFixed(1)}%"></i></span>
                    <span class="op-valor">${fmt(v, c.decimais)}</span>
                </div>`).join('')}
            </div>` : ''}

            <div class="tabela-box">
                <table>
                    <thead><tr><th>Frota</th><th>Fazenda</th><th>Operação</th>
                        <th class="num">${esc(c.unidade)}</th>
                        <th class="num" title="Horas produtivas">H.Prod.</th>
                        <th class="num" title="Horas produtivas ÷ horas apontadas">Efic.</th>
                        <th class="num">${esc(c.unidade)}/h</th></tr></thead>
                    <tbody>${linhas.map((l) => {
                        const efic = pct(l.hP, l.hApont);
                        return `
                        <tr>
                            <td class="frota-cel">${esc(l.frota)}</td>
                            <td>${esc(l.faz)}</td>
                            <td>${esc(l.oper)}</td>
                            <td class="num"><b>${fmt(l.total, c.decimais)}</b></td>
                            <td class="num" title="${l.hP} de ${plural(l.hApont, 'hora apontada', 'horas apontadas')}">${l.hP}h</td>
                            <td class="num"><span class="efic ${efic >= 80 ? 'alta' : efic >= 50 ? 'media' : 'baixa'}">${efic}%</span></td>
                            <td class="num rend">${fmt(l.total / (l.hP || 1), c.decimais)}</td>
                        </tr>`;
                    }).join('')}
                    </tbody>
                </table>
            </div>

            ${paradas.length ? `<div class="proc-rodape"><span class="badge parado">Sem produção</span> ${paradas.map(esc).join(', ')}</div>` : ''}
        </section>`;
    }

    function htmlSemProducao(lista) {
        if (!lista.length) return '';
        return `
        <section class="card proc sem-prod">
            <header class="proc-cab">
                <div>
                    <h3>Processos sem produção no dia</h3>
                    <div class="proc-meta"><span>Apontados, mas sem quantidade registrada</span></div>
                </div>
            </header>
            <div class="sem-prod-lista">${lista.map((p) =>
                `<span class="chip">${p.cfg.icone} ${esc(p.nome)} <b>${plural(p.frotas.size, 'frota', 'frotas')}</b></span>`).join('')}
            </div>
        </section>`;
    }

    function render() {
        estado.renderPendente = false;
        const dataISO = $('filtro-data').value || hojeISO();
        salvarUI(UI_KEY, { data: dataISO });
        if (garantirDados(dataISO)) estado.dados = null;

        $('rel-data').textContent = `${diaDaSemana(dataISO)}, ${isoParaBR(dataISO)}`;
        document.title = `Resumo PPT · ${isoParaBR(dataISO)}`;

        if (estado.dados === null) {
            $('lista-processos').innerHTML = `<div class="card vazio">Carregando dados…</div>`;
            return;
        }

        const res = montarResumo(estado.dados, dataISO);
        renderKPIs(res);
        $('cont-proc').textContent = plural(res.comProducao.length, 'processo', 'processos');
        $('rel-gerado').textContent = `Gerado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

        $('lista-processos').innerHTML = (res.comProducao.length || res.semProducao.length)
            ? res.comProducao.map(htmlProcesso).join('') + htmlSemProducao(res.semProducao)
            : `<div class="card vazio">Nenhum apontamento neste dia operacional.</div>`;
    }

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
        const r = await gerarPrint($('area-print'), `Resumo_PPT_${$('filtro-data').value}`, '#f3f4f6');
        btn.innerHTML = { copiado: '✓', baixado: '↓', erro: '!' }[r];
        btn.title = { copiado: 'Copiado! Cole no WhatsApp', baixado: 'Imagem baixada', erro: 'Erro ao gerar print' }[r];
        setTimeout(() => { btn.innerHTML = original; btn.title = tituloOriginal; btn.disabled = false; }, 1800);
    }

    function setStatus(classe, texto) {
        $('status-conexao').className = `pill status-conexao ${classe}`;
        $('status-texto').textContent = texto;
    }

    function iniciar() {
        const params = new URLSearchParams(location.search);
        $('filtro-data').value = params.get('data') || lerUI(UI_KEY).data || hojeISO();

        const mudarDia = (n) => { $('filtro-data').value = somarDiasISO($('filtro-data').value || hojeISO(), n); render(); };
        $('filtro-data').addEventListener('change', render);
        $('btn-dia-ant').addEventListener('click', () => mudarDia(-1));
        $('btn-dia-prox').addEventListener('click', () => mudarDia(1));
        $('btn-hoje').addEventListener('click', () => { $('filtro-data').value = hojeISO(); render(); });
        $('btnPrint').addEventListener('click', copiarPrint);
        $('btnPdf').addEventListener('click', () => window.print());

        aoMudarTurnos(agendarRender);   // turno de cada processo vem de Cadastros
        render();
    }

    // Exposto para testes
    window.USA_RESUMO = { montarResumo };
    document.addEventListener('DOMContentLoaded', iniciar);
})();
