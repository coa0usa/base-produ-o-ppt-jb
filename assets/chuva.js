// =====================================================================
//  MONITORAMENTO DE CHUVA — relatório pluviométrico editável por dia
//  Firestore: chuva_relatorios/{aaaa-mm-dd} = { obs, cards[{titulo, rows[]}], ocultos[] }
//  As frentes/fazendas com apontamento no Banco de Dados entram sozinhas;
//  as que o usuário remove ficam em "ocultos" e não voltam.
// =====================================================================
(function () {
    'use strict';

    const {
        norm, esc, fmt, plural,
        hojeISO, somarDiasISO, isoParaBR, diaDaSemana,
        regraDoRegistro, noDiaOperacional, operacaoAtiva, normalizarFazenda,
        lerUI, salvarUI, db, gerarPrint, assinaturaDoDiaOperacional, aoMudarTurnos
    } = window.USA;

    // Produção do dia operacional (para criar frentes/fazendas automaticamente)
    const garantirProducao = assinaturaDoDiaOperacional(
        (dados) => {
            estado.producao = dados;
            if (estado.relatorio && mesclarProducao(estado.relatorio, estado.dataRel)) {
                if (!editando()) renderTudo();
                agendarSalvar(0);
            }
        },
        () => setStatus('erro', 'Sem conexão')
    );

    const UI_KEY = 'usa_chuva_ui';
    const COLECAO = 'chuva_relatorios';
    const TURNOS = ['a', 'b', 'c'];
    const $ = (id) => document.getElementById(id);

    const estado = {
        producao: null,        // lista do Banco de Dados (app_data/dados)
        dataRel: null,         // data (ISO) do relatório carregado
        relatorio: null,       // relatório em edição
        ultimoJson: '',        // último estado salvo/recebido
        pendenteRemoto: null,  // atualização remota que chegou durante a digitação
        unsub: null,
        saveTimer: null
    };

    // ------------------------------------------------------------------
    //  Modelo
    // ------------------------------------------------------------------
    const mm = (v) => parseFloat(String(v == null ? '' : v).replace(',', '.')) || 0;
    const totalLinha = (r) => TURNOS.reduce((s, t) => s + mm(r[t]), 0);
    const limparTurno = (v) => { const s = String(v == null ? '' : v).trim(); return s === '0' ? '' : s; };
    const linhaVazia = (faz) => ({ faz, fonte: 'ZEUS', a: '', b: '', c: '', status: '' });

    function normalizarRelatorio(rep) {
        rep = rep || {};
        const cards = [];
        (Array.isArray(rep.cards) ? rep.cards : []).forEach((c) => {
            const titulo = norm(c && c.titulo);
            if (!titulo) return;
            let card = cards.find((x) => x.titulo === titulo);       // junta títulos repetidos
            if (!card) { card = { titulo, rows: [] }; cards.push(card); }
            (Array.isArray(c.rows) ? c.rows : []).forEach((r) => {
                const faz = normalizarFazenda(r && r.faz);
                if (/^[-\s]*$/.test(faz) || card.rows.some((x) => x.faz === faz)) return;  // vazio ou "---" antigo
                card.rows.push({
                    faz,
                    fonte: norm(r.fonte) || 'ZEUS',
                    a: limparTurno(r.a), b: limparTurno(r.b), c: limparTurno(r.c),
                    status: norm(r.status)
                });
            });
        });
        const obs = String(rep.obs || '').trim();
        return {
            obs: obs === '...' ? '' : obs,
            cards,
            ocultos: Array.isArray(rep.ocultos) ? rep.ocultos.map(String) : []
        };
    }

    // Formato gravado (mantém "total" para compatibilidade com relatórios antigos)
    function paraFirestore(rel) {
        return {
            obs: rel.obs || '',
            ocultos: rel.ocultos,
            cards: rel.cards.map((c) => ({
                titulo: norm(c.titulo) || 'SEM TÍTULO',
                rows: c.rows.filter((r) => normalizarFazenda(r.faz)).map((r) => ({
                    faz: normalizarFazenda(r.faz), fonte: norm(r.fonte) || 'ZEUS',
                    a: r.a || '0', b: r.b || '0', c: r.c || '0',
                    total: `${fmt(totalLinha(r), 1)} mm`,
                    status: norm(r.status)
                }))
            }))
        };
    }

    // Frentes (processos) e fazendas com produção no dia operacional
    function fazendasDaProducao(dataISO) {
        const mapa = new Map();
        (estado.producao || []).forEach((r) => {
            const cfg = regraDoRegistro(r.proc);
            if (!noDiaOperacional(r, cfg, dataISO)) return;
            if (!operacaoAtiva(norm(r.oper) || 'N/A')) return;
            const proc = norm(r.proc) || 'OPERACIONAL';
            const faz = normalizarFazenda(r.fazenda || r.faz) || 'SEM FAZENDA';
            if (!mapa.has(proc)) mapa.set(proc, new Set());
            mapa.get(proc).add(faz);
        });
        return mapa;
    }

    // Acrescenta o que veio da produção e ainda não está no relatório. Retorna true se mudou.
    function mesclarProducao(rel, dataISO) {
        const ocultos = new Set(rel.ocultos);
        let mudou = false;
        Array.from(fazendasDaProducao(dataISO).entries()).sort((a, b) => a[0].localeCompare(b[0])).forEach(([proc, fazs]) => {
            if (ocultos.has(`${proc}|*`)) return;
            let card = rel.cards.find((c) => c.titulo === proc);
            const novas = Array.from(fazs).sort()
                .filter((f) => !ocultos.has(`${proc}|${f}`) && !(card && card.rows.some((r) => r.faz === f)));
            if (!novas.length) return;
            if (!card) { card = { titulo: proc, rows: [] }; rel.cards.push(card); }
            novas.forEach((f) => card.rows.push(linhaVazia(f)));
            mudou = true;
        });
        return mudou;
    }

    // ------------------------------------------------------------------
    //  Persistência
    // ------------------------------------------------------------------
    function setStatus(classe, texto) {
        $('status-conexao').className = `pill status-conexao ${classe}`;
        $('status-texto').textContent = texto;
    }

    function agendarSalvar(ms) {
        clearTimeout(estado.saveTimer);
        setStatus('', 'Salvando…');
        estado.saveTimer = setTimeout(salvarAgora, ms == null ? 600 : ms);
    }

    function salvarAgora() {
        clearTimeout(estado.saveTimer);
        estado.saveTimer = null;
        const rel = estado.relatorio, data = estado.dataRel;
        if (!rel || !data) return;
        const doc = paraFirestore(rel);
        const json = JSON.stringify(normalizarRelatorio(doc));
        if (json === estado.ultimoJson) { setStatus('online', 'Salvo'); return; }
        estado.ultimoJson = json;
        db().collection(COLECAO).doc(data).set(doc)
            .then(() => setStatus('online', `Salvo ${new Date().toLocaleTimeString('pt-BR')}`))
            .catch((e) => { console.error(e); setStatus('erro', 'Erro ao salvar'); });
    }

    const editando = () => {
        const a = document.activeElement;
        return !!(a && a.closest && a.closest('#area-print') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
    };

    function aplicarRelatorio(rel) {
        estado.pendenteRemoto = null;
        estado.relatorio = rel;
        estado.ultimoJson = JSON.stringify(rel);
        if (estado.producao !== null && mesclarProducao(rel, estado.dataRel)) agendarSalvar(0);
        renderTudo();
    }

    function abrirData(dataISO) {
        if (estado.saveTimer) salvarAgora();          // não perde a digitação do dia anterior
        if (estado.unsub) estado.unsub();
        estado.dataRel = dataISO;
        estado.relatorio = null;
        estado.ultimoJson = '';
        estado.pendenteRemoto = null;
        if (garantirProducao(dataISO)) estado.producao = null;
        salvarUI(UI_KEY, { data: dataISO });
        renderTudo();

        estado.unsub = db().collection(COLECAO).doc(dataISO).onSnapshot((doc) => {
            if (doc.metadata.hasPendingWrites) return;             // eco da própria gravação
            const rel = normalizarRelatorio(doc.exists ? doc.data() : null);
            if (estado.relatorio && JSON.stringify(rel) === estado.ultimoJson) return;
            if (estado.relatorio && editando()) { estado.pendenteRemoto = rel; return; }
            aplicarRelatorio(rel);
        }, (e) => { console.error(e); setStatus('erro', 'Sem conexão'); });
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    function classeChuva(v) { return v <= 0 ? 'mm0' : v < 5 ? 'mm1' : v < 20 ? 'mm2' : 'mm3'; }
    const classeStatus = (s) => (s === 'TRABALHANDO' ? 'st-trab' : s === 'PARADO' ? 'st-parado' : '');

    function htmlLinha(r, ci, ri) {
        const total = totalLinha(r);
        const opcoes = ['', 'TRABALHANDO', 'PARADO'];
        if (r.status && !opcoes.includes(r.status)) opcoes.push(r.status);
        return `<tr data-c="${ci}" data-r="${ri}" class="${r.faz ? '' : 'linha-nova'}">
            <td><input class="in-faz" data-campo="faz" value="${esc(r.faz)}" placeholder="Nome da fazenda / talhão" aria-label="Fazenda"></td>
            <td><input class="in-fonte" data-campo="fonte" list="opcoes-fonte" value="${esc(r.fonte)}" aria-label="Fonte"></td>
            ${TURNOS.map((t) => `<td class="col-mm"><input class="in-mm" data-campo="${t}" inputmode="decimal" value="${esc(r[t])}" placeholder="–" aria-label="Turno ${t.toUpperCase()}"></td>`).join('')}
            <td class="col-total"><span class="total ${classeChuva(total)}">${fmt(total, 1)} mm</span></td>
            <td><select class="in-status ${classeStatus(r.status)}" data-campo="status" aria-label="Status">
                ${opcoes.map((o) => `<option value="${esc(o)}" ${o === r.status ? 'selected' : ''}>${o ? esc(o) : 'Selecione…'}</option>`).join('')}
            </select></td>
            <td class="so-tela col-acao"><button type="button" class="btn-x" data-acao="del-faz" title="Remover fazenda">✕</button></td>
        </tr>`;
    }

    function resumoFrente(c) {
        const totais = c.rows.filter((r) => r.faz).map(totalLinha);
        const comChuva = totais.filter((v) => v > 0).length;
        const max = totais.length ? Math.max(...totais) : 0;
        return `${plural(totais.length, 'fazenda', 'fazendas')} · ${comChuva ? `${comChuva} com chuva · máx. ${fmt(max, 1)} mm` : 'sem chuva'}`;
    }

    function htmlFrente(c, ci) {
        return `<section class="card frente" data-c="${ci}">
            <header class="frente-cab">
                <div class="frente-tit">
                    <input class="in-titulo" data-campo="titulo" value="${esc(c.titulo)}" aria-label="Nome da frente">
                    <span class="frente-resumo" data-resumo="${ci}">${resumoFrente(c)}</span>
                </div>
                <div class="so-tela frente-acoes">
                    <button type="button" class="btn-sec" data-acao="add-faz">+ Fazenda</button>
                    <button type="button" class="btn-sec perigo" data-acao="del-frente">Remover frente</button>
                </div>
            </header>
            <div class="tabela-box">
                <table class="tab-chuva">
                    <thead><tr>
                        <th>Fazenda / talhão</th><th>Fonte</th>
                        <th class="num">Turno A</th><th class="num">Turno B</th><th class="num">Turno C</th>
                        <th class="num">Total 24h</th><th>Status</th><th class="so-tela"></th>
                    </tr></thead>
                    <tbody>${c.rows.map((r, ri) => htmlLinha(r, ci, ri)).join('') ||
                        `<tr><td colspan="8" class="vazio">Nenhuma fazenda. Use “+ Fazenda”.</td></tr>`}</tbody>
                </table>
            </div>
        </section>`;
    }

    function renderIndicadores() {
        const rel = estado.relatorio;
        const linhas = rel ? rel.cards.flatMap((c) => c.rows.filter((r) => r.faz)) : [];
        const comChuva = linhas.filter((r) => totalLinha(r) > 0);
        const maior = linhas.reduce((m, r) => (totalLinha(r) > (m ? totalLinha(m) : 0) ? r : m), null);
        const paradas = linhas.filter((r) => r.status === 'PARADO').length;
        const media = comChuva.length ? comChuva.reduce((s, r) => s + totalLinha(r), 0) / comChuva.length : 0;

        $('k_faz').textContent = String(linhas.length);
        $('k_faz_det').textContent = rel ? plural(rel.cards.length, 'frente', 'frentes') : '';
        $('k_chuva').textContent = String(comChuva.length);
        $('k_chuva_det').innerHTML = comChuva.length ? `média <b>${fmt(media, 1)} mm</b>` : 'nenhuma fazenda';
        $('k_max').innerHTML = `${fmt(maior ? totalLinha(maior) : 0, 1)}<small>mm</small>`;
        $('k_max_det').textContent = maior ? maior.faz : '—';
        $('k_parado').textContent = String(paradas);

        const st = $('status-dia');
        if (!rel) {
            st.className = 'status-dia'; $('status-titulo').textContent = 'Carregando…'; $('status-sub').textContent = '';
        } else if (!linhas.length) {
            st.className = 'status-dia'; $('status-titulo').textContent = 'Nenhuma fazenda no relatório';
            $('status-sub').textContent = 'As frentes entram sozinhas quando houver apontamento no Banco de Dados, ou use “+ Frente”.';
        } else if (!comChuva.length) {
            st.className = 'status-dia ok'; $('status-titulo').textContent = 'Sem chuva registrada';
            $('status-sub').textContent = `${plural(linhas.length, 'fazenda monitorada', 'fazendas monitoradas')}` + (paradas ? ` · ${paradas} parada(s)` : '');
        } else {
            st.className = 'status-dia chuva';
            $('status-titulo').textContent = `Chuva em ${comChuva.length} de ${plural(linhas.length, 'fazenda', 'fazendas')}`;
            $('status-sub').textContent = `Maior acumulado: ${fmt(totalLinha(maior), 1)} mm em ${maior.faz}` + (paradas ? ` · ${paradas} fazenda(s) com operação parada` : '');
        }
    }

    function renderTudo() {
        const dataISO = estado.dataRel || hojeISO();
        $('rel-data').textContent = `${diaDaSemana(dataISO)}, ${isoParaBR(dataISO)}`;
        document.title = `Chuva · ${isoParaBR(dataISO)}`;
        const rel = estado.relatorio;
        $('lista-frentes').innerHTML = !rel
            ? `<div class="card vazio">Carregando relatório…</div>`
            : rel.cards.map(htmlFrente).join('') || `<div class="card vazio">Nenhuma frente neste dia.</div>`;
        const obs = $('obs-geral');
        if (document.activeElement !== obs) obs.value = rel ? rel.obs : '';
        obs.disabled = !rel;
        renderIndicadores();
    }

    // ------------------------------------------------------------------
    //  Edição (delegação de eventos)
    // ------------------------------------------------------------------
    function sanitizarMm(input) {
        let v = input.value.replace(/\./g, ',').replace(/[^\d,]/g, '');
        const i = v.indexOf(',');
        if (i !== -1) v = v.slice(0, i + 1) + v.slice(i + 1).replace(/,/g, '');
        if (v !== input.value) input.value = v;
        return v;
    }

    function aoDigitar(e) {
        const el = e.target;
        const campo = el.dataset.campo;
        if (!campo || !estado.relatorio) return;
        const ci = Number(el.closest('[data-c]').dataset.c);
        const card = estado.relatorio.cards[ci];

        if (campo === 'titulo') {
            card.titulo = el.value.toUpperCase();
        } else {
            const tr = el.closest('tr');
            const r = card.rows[Number(tr.dataset.r)];
            if (TURNOS.includes(campo)) {
                r[campo] = sanitizarMm(el);
                const total = totalLinha(r);
                const span = tr.querySelector('.total');
                span.textContent = `${fmt(total, 1)} mm`;
                span.className = `total ${classeChuva(total)}`;
            } else if (campo === 'status') {
                r.status = el.value;
                el.className = `in-status ${classeStatus(r.status)}`;
            } else {
                r[campo] = el.value.toUpperCase();
            }
            const res = document.querySelector(`[data-resumo="${ci}"]`);
            if (res) res.textContent = resumoFrente(card);
        }
        renderIndicadores();
        agendarSalvar();
    }

    function aoClicar(e) {
        const btn = e.target.closest('[data-acao]');
        if (!btn || !estado.relatorio) return;
        const rel = estado.relatorio;
        const ci = Number(btn.closest('[data-c]').dataset.c);
        const card = rel.cards[ci];

        if (btn.dataset.acao === 'add-faz') {
            card.rows.push(linhaVazia(''));
            renderTudo();
            const linhas = document.querySelectorAll(`section[data-c="${ci}"] tbody tr`);
            linhas[linhas.length - 1].querySelector('.in-faz').focus();
            return;   // salva quando a fazenda receber nome
        }
        if (btn.dataset.acao === 'del-faz') {
            const r = card.rows[Number(btn.closest('tr').dataset.r)];
            if (r.faz && !confirm(`Remover a fazenda ${r.faz} do relatório de chuva?`)) return;
            if (r.faz) rel.ocultos.push(`${card.titulo}|${normalizarFazenda(r.faz)}`);
            card.rows.splice(card.rows.indexOf(r), 1);
        }
        if (btn.dataset.acao === 'del-frente') {
            if (!confirm(`Remover a frente ${card.titulo} inteira do relatório de chuva?`)) return;
            rel.ocultos.push(`${card.titulo}|*`);
            rel.cards.splice(ci, 1);
        }
        renderTudo();
        agendarSalvar(0);
    }

    function addFrente() {
        if (!estado.relatorio) return;
        estado.relatorio.cards.push({ titulo: 'NOVA FRENTE', rows: [linhaVazia('')] });
        renderTudo();
        const sec = document.querySelectorAll('section.frente');
        const tit = sec[sec.length - 1].querySelector('.in-titulo');
        tit.focus(); tit.select();
        agendarSalvar();
    }

    // Enter avança para o próximo campo
    function aoTeclar(e) {
        if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
        e.preventDefault();
        const campos = Array.from(document.querySelectorAll('#lista-frentes input'));
        const prox = campos[campos.indexOf(e.target) + 1];
        if (prox) { prox.focus(); prox.select(); } else e.target.blur();
    }

    // Ao sair de um campo: aplica atualização remota que ficou esperando
    function aoSairDoCampo() {
        setTimeout(() => {
            if (editando()) return;
            if (estado.saveTimer) salvarAgora();
            if (estado.pendenteRemoto) aplicarRelatorio(estado.pendenteRemoto);
        }, 0);
    }

    async function copiarPrint() {
        const btn = $('btnPrint');
        if (btn.disabled) return;
        const original = btn.innerHTML, titulo = btn.title;
        btn.disabled = true; btn.innerHTML = '…';
        document.body.classList.add('modo-print');
        const r = await gerarPrint($('area-print'), `Chuva_${estado.dataRel}`, '#f3f4f6');
        document.body.classList.remove('modo-print');
        btn.innerHTML = { copiado: '✓', baixado: '↓', erro: '!' }[r];
        btn.title = { copiado: 'Copiado! Cole no WhatsApp', baixado: 'Imagem baixada', erro: 'Erro ao gerar print' }[r];
        setTimeout(() => { btn.innerHTML = original; btn.title = titulo; btn.disabled = false; }, 1800);
    }

    // ------------------------------------------------------------------
    //  Inicialização
    // ------------------------------------------------------------------
    function iniciar() {
        const params = new URLSearchParams(location.search);
        const inicial = params.get('data') || lerUI(UI_KEY).data || hojeISO();
        $('filtro-data').value = inicial;

        const irPara = (iso) => { $('filtro-data').value = iso; abrirData(iso); };
        $('filtro-data').addEventListener('change', () => abrirData($('filtro-data').value || hojeISO()));
        $('btn-dia-ant').addEventListener('click', () => irPara(somarDiasISO(estado.dataRel, -1)));
        $('btn-dia-prox').addEventListener('click', () => irPara(somarDiasISO(estado.dataRel, 1)));
        $('btn-hoje').addEventListener('click', () => irPara(hojeISO()));
        $('btnPrint').addEventListener('click', copiarPrint);
        $('btnAddFrente').addEventListener('click', addFrente);

        const lista = $('lista-frentes');
        lista.addEventListener('input', aoDigitar);
        lista.addEventListener('change', aoDigitar);
        lista.addEventListener('click', aoClicar);
        lista.addEventListener('keydown', aoTeclar);
        $('area-print').addEventListener('focusout', aoSairDoCampo);
        $('obs-geral').addEventListener('input', (e) => {
            if (!estado.relatorio) return;
            estado.relatorio.obs = e.target.value;
            agendarSalvar();
        });
        window.addEventListener('beforeunload', () => { if (estado.saveTimer) salvarAgora(); });

        // turno de cada processo (Cadastros) define quais fazendas entram no dia
        aoMudarTurnos(() => {
            if (estado.relatorio && estado.producao && mesclarProducao(estado.relatorio, estado.dataRel)) {
                if (!editando()) renderTudo();
                agendarSalvar(0);
            }
        });
        abrirData(inicial);
        setStatus('online', 'Conectado');
    }

    window.USA_CHUVA = { normalizarRelatorio, paraFirestore, mesclarProducao, totalLinha, _estado: estado };
    document.addEventListener('DOMContentLoaded', iniciar);
})();
