// =====================================================================
//  CADASTROS — processos, operações e motivos de parada
//  Firestore: app_data/config = { processos[], operacoes{proc: []}, motivos[] }
//  Cada alteração grava SÓ o item alterado (arrayUnion/arrayRemove),
//  então dois usuários editando ao mesmo tempo não se sobrescrevem.
// =====================================================================
(function () {
    'use strict';

    const { CFG, norm, esc, plural, configDoProcesso, corDoMotivo, db, conectar, lerPeriodo, hojeISO, somarDiasISO,
        horasDaRegra, fimPadrao } = window.USA;
    const pad2 = (n) => String(n).padStart(2, '0');
    const DIAS_USO = 30;   // contagem de uso considera só os últimos 30 dias (não baixa o histórico todo)
    const $ = (id) => document.getElementById(id);

    const estado = {
        config: null,          // { processos, operacoes, motivos }
        cores: {},
        uso: null,             // contagem de apontamentos por item
        aba: 'processos',
        proc: null,            // processo selecionado em "Operações"
        busca: ''
    };

    const TEXTOS = {
        processos: { placeholder: 'Novo processo (ex.: PLANTIO MEIOSE)', item: 'processo' },
        operacoes: { placeholder: 'Nova operação para o processo selecionado', item: 'operação' },
        motivos:   { placeholder: 'Novo motivo de parada (ex.: SOLO UMIDO - CHUVA)', item: 'motivo' }
    };

    // ------------------------------------------------------------------
    //  Dados
    // ------------------------------------------------------------------
    const lista = (k) => (estado.config && Array.isArray(estado.config[k]) ? estado.config[k] : []);
    const operacoesDe = (p) => (estado.config && estado.config.operacoes && estado.config.operacoes[p]) || [];

    function contarUso(dados) {
        const uso = { proc: new Map(), oper: new Map(), motivo: new Map() };
        const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
        dados.forEach((r) => {
            const p = norm(r.proc);
            inc(uso.proc, p);
            inc(uso.oper, `${p}|${norm(r.oper)}`);
            if (norm(r.status) !== 'PRODUTIVO') inc(uso.motivo, norm(r.motivo));
        });
        return uso;
    }
    function usoDe(tipo, chave) {
        if (!estado.uso) return null;
        return estado.uso[tipo].get(chave) || 0;
    }
    const textoUso = (n) => (n === null ? '' : n ? `${n.toLocaleString('pt-BR')} apontamentos em ${DIAS_USO} dias` : `sem uso em ${DIAS_USO} dias`);

    // ------------------------------------------------------------------
    //  Gravação (atômica por item)
    // ------------------------------------------------------------------
    const FV = () => firebase.firestore.FieldValue;
    const ref = () => db().collection('app_data').doc('config');

    function gravar(alteracao, msgOk) {
        aviso('', 'Salvando…');
        return ref().set(alteracao, { merge: true })
            .then(() => aviso('ok', msgOk))
            .catch((e) => { console.error(e); aviso('erro', 'Não foi possível salvar. Verifique a conexão.'); });
    }

    function adicionar() {
        const nome = norm($('novo-nome').value).replace(/\s+/g, ' ');
        if (!nome) return aviso('erro', 'Digite um nome.');

        if (estado.aba === 'operacoes') {
            if (!estado.proc) return aviso('erro', 'Selecione um processo primeiro.');
            if (operacoesDe(estado.proc).some((o) => norm(o) === nome)) return aviso('erro', `${nome} já existe em ${estado.proc}.`);
            gravar({ operacoes: { [estado.proc]: FV().arrayUnion(nome) } }, `Operação ${nome} adicionada a ${estado.proc}.`);
        } else {
            const k = estado.aba;
            if (lista(k).some((x) => norm(x) === nome)) return aviso('erro', `${nome} já está cadastrado.`);
            gravar({ [k]: FV().arrayUnion(nome) }, `${nome} cadastrado.`);
        }
        $('novo-nome').value = '';
        $('novo-nome').focus();
    }

    function remover(tipo, nome) {
        let n, msg;
        if (tipo === 'processos') {
            n = usoDe('proc', norm(nome));
            const nOps = operacoesDe(nome).length;
            msg = `Excluir o processo ${nome}` + (nOps ? ` e suas ${nOps} operações` : '') + '?';
        } else if (tipo === 'operacoes') {
            n = usoDe('oper', `${norm(estado.proc)}|${norm(nome)}`);
            msg = `Excluir a operação ${nome} de ${estado.proc}?`;
        } else {
            n = usoDe('motivo', norm(nome));
            msg = `Excluir o motivo ${nome}?`;
        }
        if (n) msg += `\n\nAtenção: ele aparece em ${n.toLocaleString('pt-BR')} apontamentos dos últimos ${DIAS_USO} dias. Os apontamentos NÃO serão apagados, mas o item some das listas de lançamento.`;
        if (!confirm(msg)) return;

        if (tipo === 'processos') {
            gravar({ processos: FV().arrayRemove(nome), operacoes: { [nome]: FV().delete() }, turnos: { [norm(nome)]: FV().delete() } }, `Processo ${nome} excluído.`);
            if (estado.proc === nome) estado.proc = null;
        } else if (tipo === 'operacoes') {
            gravar({ operacoes: { [estado.proc]: FV().arrayRemove(nome) } }, `Operação ${nome} excluída.`);
        } else {
            gravar({ motivos: FV().arrayRemove(nome) }, `Motivo ${nome} excluído.`);
        }
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    function aviso(tipo, texto) {
        const el = $('aviso');
        el.className = `aviso ${tipo}`;
        el.textContent = texto;
        clearTimeout(aviso.t);
        if (tipo === 'ok') aviso.t = setTimeout(() => { el.textContent = ''; }, 4000);
    }

    const casaBusca = (txt) => !estado.busca || norm(txt).includes(estado.busca);
    const porNome = (a, b) => a.localeCompare(b, 'pt-BR');

    // ------------------------------------------------------------------
    //  Turno do processo (hora início / hora fim) → gráfico e dia operacional
    // ------------------------------------------------------------------
    const opcoesHora = (sel) => Array.from({ length: 24 }, (_, h) =>
        `<option value="${h}" ${h === sel ? 'selected' : ''}>${pad2(h)}:00</option>`).join('');

    function htmlTurno(p, c) {
        const dur = horasDaRegra(c).length;
        return `<div class="turno-edit">
            <label>Início<select class="campo-mini" data-turno="inicio" data-nome="${esc(p)}">${opcoesHora(c.inicioTurno)}</select></label>
            <label>Fim<select class="campo-mini" data-turno="fim" data-nome="${esc(p)}">${opcoesHora(c.fimTurno)}</select></label>
            <span class="turno-info">${pad2(c.inicioTurno)}h → ${pad2(c.fimTurno)}h59 · ${dur}h</span>
            ${c.turnoCadastrado
                ? `<span class="turno-tag cad">cadastrado</span><button type="button" class="btn-link" data-acao="turno-padrao" data-nome="${esc(p)}">usar padrão</button>`
                : '<span class="turno-tag">padrão</span>'}
        </div>`;
    }

    function salvarTurno(nome, campo, valor) {
        const c = configDoProcesso(nome);
        let inicio = c.inicioTurno, fim = c.fimTurno;
        if (campo === 'inicio') {
            // sem turno cadastrado: mudar o início leva o fim junto (mantém 24h)
            if (!c.turnoCadastrado) fim = fimPadrao(valor);
            inicio = valor;
        } else {
            fim = valor;
        }
        const dur = ((fim - inicio + 24) % 24) + 1;
        gravar({ turnos: { [norm(nome)]: { inicio, fim } } },
            `Turno de ${nome}: ${pad2(inicio)}h → ${pad2(fim)}h59 (${dur}h). Os gráficos já usam o novo horário.`);
    }

    function htmlProcessos() {
        const itens = lista('processos').filter(casaBusca);
        if (!itens.length) return vazio('processo');
        return itens.map((p) => {
            const c = configDoProcesso(p);
            const regras = CFG.PROCESSOS.some((x) => norm(x.nome) === norm(p));
            const nOps = operacoesDe(p).length;
            return `<div class="item item-proc">
                <div class="item-principal">
                    <div class="item-nome">${c.icone} ${esc(p)}</div>
                    <div class="item-meta">
                        <span>${plural(nOps, 'operação', 'operações')}</span>
                        <span>${esc(c.unidade)}</span>
                        ${regras ? '' : '<span class="tag-aviso" title="Sem regra em graficos-config.js — usa o padrão">regra padrão</span>'}
                        <span>${textoUso(usoDe('proc', norm(p)))}</span>
                    </div>
                    ${htmlTurno(p, c)}
                </div>
                <button type="button" class="btn-sec" data-acao="ver-ops" data-nome="${esc(p)}">Operações</button>
                <button type="button" class="btn-x" data-acao="remover" data-tipo="processos" data-nome="${esc(p)}" title="Excluir">✕</button>
            </div>`;
        }).join('');
    }

    function htmlOperacoes() {
        const procs = lista('processos');
        if (!procs.length) return vazio('processo');
        if (!estado.proc || !procs.includes(estado.proc)) estado.proc = procs[0];

        const menu = procs.map((p) => `<button type="button" class="proc-item ${p === estado.proc ? 'ativo' : ''}" data-acao="sel-proc" data-nome="${esc(p)}">
            <span>${configDoProcesso(p).icone} ${esc(p)}</span><span class="n">${operacoesDe(p).length}</span></button>`).join('');

        const ops = operacoesDe(estado.proc).filter(casaBusca);
        const itens = ops.length ? ops.map((o) => `<div class="item">
                <div class="item-principal">
                    <div class="item-nome">${esc(o)}</div>
                    <div class="item-meta"><span>${textoUso(usoDe('oper', `${norm(estado.proc)}|${norm(o)}`))}</span></div>
                </div>
                <button type="button" class="btn-x" data-acao="remover" data-tipo="operacoes" data-nome="${esc(o)}" title="Excluir">✕</button>
            </div>`).join('') : vazio('operação');

        return `<div class="dois-paineis">
            <nav class="proc-menu" aria-label="Processos">${menu}</nav>
            <div><div class="painel-tit">Operações de <b>${esc(estado.proc)}</b></div>${itens}</div>
        </div>`;
    }

    function htmlMotivos() {
        const itens = lista('motivos').filter(casaBusca).slice().sort(porNome);
        if (!itens.length) return vazio('motivo');
        return itens.map((m) => `<div class="item">
                <span class="amostra-cor" style="background:${esc(corDoMotivo(norm(m), estado.cores))}"></span>
                <div class="item-principal">
                    <div class="item-nome">${esc(m)}</div>
                    <div class="item-meta"><span>${textoUso(usoDe('motivo', norm(m)))}</span></div>
                </div>
                <a class="btn-sec" href="Gestor de Cores.html?m=${encodeURIComponent(norm(m))}">Cor</a>
                <button type="button" class="btn-x" data-acao="remover" data-tipo="motivos" data-nome="${esc(m)}" title="Excluir">✕</button>
            </div>`).join('');
    }

    const vazio = (o) => `<div class="vazio">${estado.busca ? `Nenhum(a) ${o} encontrado(a) para “${esc(estado.busca)}”.` : `Nenhum(a) ${o} cadastrado(a).`}</div>`;

    function render() {
        if (!estado.config) { $('lista').innerHTML = '<div class="vazio">Carregando cadastros…</div>'; return; }

        $('n-processos').textContent = lista('processos').length;
        $('n-operacoes').textContent = lista('processos').reduce((s, p) => s + operacoesDe(p).length, 0);
        $('n-motivos').textContent = lista('motivos').length;
        document.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('ativo', b.dataset.aba === estado.aba));

        $('novo-nome').placeholder = TEXTOS[estado.aba].placeholder;
        $('lista').innerHTML = estado.aba === 'processos' ? htmlProcessos()
            : estado.aba === 'operacoes' ? htmlOperacoes() : htmlMotivos();
        $('dica').innerHTML = estado.aba === 'processos'
            ? 'O menu da página de Gráficos mostra exatamente esta lista. <b>Início/Fim</b> definem as horas do gráfico e do dia operacional de cada processo (ex.: 05:00 → 04:00 = 24h; 07:00 → 17:00 = só o horário de trabalho). Unidade e ícone vêm de <code>assets/graficos-config.js</code>.'
            : estado.aba === 'operacoes'
                ? 'As operações aparecem no lançamento do Banco de Dados conforme o processo escolhido.'
                : 'A cor de cada motivo nos gráficos é definida no Gestor de Cores.';
    }

    function setStatus(classe, texto) {
        $('status-conexao').className = `pill status-conexao ${classe}`;
        $('status-texto').textContent = texto;
    }

    // ------------------------------------------------------------------
    //  Inicialização
    // ------------------------------------------------------------------
    function iniciar() {
        const aba = new URLSearchParams(location.search).get('aba');
        if (TEXTOS[aba]) estado.aba = aba;

        document.querySelector('.seg').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-aba]');
            if (!b) return;
            estado.aba = b.dataset.aba;
            estado.busca = ''; $('busca').value = '';
            aviso('', '');
            render();
        });
        $('form-novo').addEventListener('submit', (e) => { e.preventDefault(); adicionar(); });
        $('busca').addEventListener('input', (e) => { estado.busca = norm(e.target.value); render(); });
        $('lista').addEventListener('change', (e) => {
            const s = e.target.closest('select[data-turno]');
            if (s) salvarTurno(s.dataset.nome, s.dataset.turno, parseInt(s.value, 10));
        });
        $('lista').addEventListener('click', (e) => {
            const b = e.target.closest('[data-acao]');
            if (!b) return;
            const nome = b.dataset.nome;
            if (b.dataset.acao === 'remover') remover(b.dataset.tipo, nome);
            if (b.dataset.acao === 'turno-padrao') {
                gravar({ turnos: { [norm(nome)]: FV().delete() } }, `${nome} voltou ao turno padrão do sistema.`);
            }
            if (b.dataset.acao === 'sel-proc') { estado.proc = nome; render(); }
            if (b.dataset.acao === 'ver-ops') { estado.aba = 'operacoes'; estado.proc = nome; estado.busca = ''; $('busca').value = ''; render(); $('novo-nome').focus(); }
        });

        render();
        conectar({
            onConfig: (cfg) => {
                estado.config = { processos: cfg.processos || [], operacoes: cfg.operacoes || {}, motivos: cfg.motivos || [] };
                setStatus('online', `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
                render();
            },
            onCores: (mapa) => { estado.cores = mapa; if (estado.aba === 'motivos') render(); },
            onErro: () => setStatus('erro', 'Sem conexão')
        });
        lerPeriodo(somarDiasISO(hojeISO(), -DIAS_USO), hojeISO())
            .then((dados) => { estado.uso = contarUso(dados); render(); })
            .catch((e) => console.error('Contagem de uso indisponível:', e));
    }

    window.USA_CADASTROS = { contarUso };
    document.addEventListener('DOMContentLoaded', iniciar);
})();
