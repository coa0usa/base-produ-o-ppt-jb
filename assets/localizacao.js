// =====================================================================
//  LOCALIZAÇÃO DA FROTA — onde cada frota estava no último apontamento
//  do dia operacional, agrupado por processo e fazenda.
// =====================================================================
(function () {
    'use strict';

    const {
        norm, esc, plural, pad,
        hojeISO, somarDiasISO, isoParaBR, diaDaSemana, horaDoRegistro,
        regraDoRegistro, noDiaOperacional, nomeDaFrota, normalizarFazenda,
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

    const UI_KEY = 'usa_localizacao_ui';
    const $ = (id) => document.getElementById(id);
    const estado = { dados: null, renderPendente: false };

    // "20/11/2026" + 3h → 2026112003 (ordem cronológica real, atravessa a meia-noite)
    function instante(r) {
        const p = String(r.data || '').trim().split('/');
        if (p.length !== 3) return -1;
        return Number(`${p[2]}${pad(p[1])}${pad(p[0])}${pad(horaDoRegistro(r))}`);
    }

    // ------------------------------------------------------------------
    //  Cálculo (sem DOM)
    // ------------------------------------------------------------------
    function montarLocalizacao(dados, dataISO) {
        const frotas = new Map();   // frota → { ultimo, fazendas: Set }
        dados.forEach((r) => {
            const cfg = regraDoRegistro(r.proc);
            if (!noDiaOperacional(r, cfg, dataISO)) return;
            const id = nomeDaFrota(r.eq);
            const faz = normalizarFazenda(r.fazenda || r.faz);
            const t = instante(r);
            const f = frotas.get(id) || { id, ultimo: null, t: -1, fazendas: new Set() };
            if (faz) f.fazendas.add(faz);
            if (t >= f.t) { f.t = t; f.ultimo = r; }
            frotas.set(id, f);
        });

        // Agrupa pelo processo e fazenda do ÚLTIMO apontamento de cada frota
        const processos = new Map();
        frotas.forEach((f) => {
            const r = f.ultimo;
            const proc = norm(r.proc) || 'OUTROS';
            const faz = normalizarFazenda(r.fazenda || r.faz) || 'SEM FAZENDA';
            const produtivo = norm(r.status) === 'PRODUTIVO';
            const item = {
                id: f.id,
                hora: pad(horaDoRegistro(r)),
                produtivo,
                motivo: produtivo ? '' : (norm(r.motivo) || 'SEM MOTIVO'),
                oper: norm(r.oper),
                antes: Array.from(f.fazendas).filter((x) => x !== faz)
            };
            const p = processos.get(proc) || { nome: proc, cfg: regraDoRegistro(proc), fazendas: new Map(), nFrotas: 0 };
            const lista = p.fazendas.get(faz) || [];
            lista.push(item);
            p.fazendas.set(faz, lista);
            p.nFrotas++;
            processos.set(proc, p);
        });

        const lista = Array.from(processos.values()).sort((a, b) => a.nome.localeCompare(b.nome));
        const todas = Array.from(frotas.values());
        return {
            processos: lista,
            nFrotas: todas.length,
            nProduzindo: todas.filter((f) => norm(f.ultimo.status) === 'PRODUTIVO').length,
            nFazendas: new Set(lista.flatMap((p) => Array.from(p.fazendas.keys()))).size
        };
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    const porNumero = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true });

    function chipFrota(it) {
        const dica = [`Último apontamento ${it.hora}h`, it.produtivo ? `Produzindo${it.oper ? ' · ' + it.oper : ''}` : `Parado · ${it.motivo}`];
        if (it.antes.length) dica.push(`Antes em: ${it.antes.join(', ')}`);
        return `<span class="frota-chip ${it.produtivo ? 'prod' : 'parado'}" title="${esc(dica.join('\n'))}">
            <span class="ponto"></span><b>${esc(it.id)}</b><small>${it.hora}h</small>${it.antes.length ? '<i class="mudou" title="Passou por outra fazenda no dia">↺</i>' : ''}
        </span>`;
    }

    function render() {
        estado.renderPendente = false;
        const dataISO = $('filtro-data').value || hojeISO();
        salvarUI(UI_KEY, { data: dataISO });
        if (garantirDados(dataISO)) estado.dados = null;
        $('rel-data').textContent = `${diaDaSemana(dataISO)}, ${isoParaBR(dataISO)}`;
        document.title = `Localização · ${isoParaBR(dataISO)}`;

        if (estado.dados === null) {
            $('lista').innerHTML = `<div class="card vazio">Carregando dados…</div>`;
            return;
        }

        const res = montarLocalizacao(estado.dados, dataISO);
        $('k_frotas').textContent = String(res.nFrotas);
        $('k_prod').textContent = String(res.nProduzindo);
        $('k_prod_det').innerHTML = `de <b>${res.nFrotas}</b> no último apontamento`;
        $('k_parado').textContent = String(res.nFrotas - res.nProduzindo);
        $('k_faz').textContent = String(res.nFazendas);
        $('k_faz_det').textContent = plural(res.processos.length, 'processo', 'processos');
        $('rel-gerado').textContent = `Gerado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

        const busca = norm($('busca').value);
        const casa = (txt) => !busca || txt.includes(busca);

        const html = res.processos.map((p) => {
            const linhas = Array.from(p.fazendas.entries())
                .map(([faz, itens]) => [faz, casa(faz) ? itens : itens.filter((it) => casa(it.id))])
                .filter(([, itens]) => itens.length)
                .sort((a, b) => a[0].localeCompare(b[0]));
            if (!linhas.length) return '';

            return `
            <section class="card proc-loc">
                <header class="proc-loc-cab">
                    <h3>${p.cfg.icone} ${esc(p.nome)}</h3>
                    <span class="proc-loc-meta">${plural(p.nFrotas, 'frota', 'frotas')} · ${plural(p.fazendas.size, 'fazenda', 'fazendas')}</span>
                </header>
                ${linhas.map(([faz, itens]) => `
                <div class="faz-linha">
                    <div class="faz-nome">${esc(faz)}</div>
                    <div class="faz-frotas">${itens.sort((a, b) => porNumero(a.id, b.id)).map(chipFrota).join('')}</div>
                </div>`).join('')}
            </section>`;
        }).join('');

        $('lista').innerHTML = html ||
            `<div class="card vazio">${res.nFrotas ? 'Nenhuma frota ou fazenda encontrada para a busca.' : 'Sem apontamentos neste dia operacional.'}</div>`;
    }

    function agendarRender() {
        if (estado.renderPendente) return;
        estado.renderPendente = true;
        requestAnimationFrame(render);
    }

    async function copiarPrint() {
        const btn = $('btnPrint');
        if (btn.disabled) return;
        const original = btn.innerHTML, titulo = btn.title;
        btn.disabled = true; btn.innerHTML = '…';
        const r = await gerarPrint($('area-print'), `Localizacao_Frota_${$('filtro-data').value}`, '#f3f4f6');
        btn.innerHTML = { copiado: '✓', baixado: '↓', erro: '!' }[r];
        btn.title = { copiado: 'Copiado! Cole no WhatsApp', baixado: 'Imagem baixada', erro: 'Erro ao gerar print' }[r];
        setTimeout(() => { btn.innerHTML = original; btn.title = titulo; btn.disabled = false; }, 1800);
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
        $('busca').addEventListener('input', render);
        $('btnPrint').addEventListener('click', copiarPrint);

        aoMudarTurnos(agendarRender);   // turno de cada processo vem de Cadastros
        render();
    }

    window.USA_LOCALIZACAO = { montarLocalizacao };
    document.addEventListener('DOMContentLoaded', iniciar);
})();
