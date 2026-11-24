// =====================================================================
//  GESTOR DE CORES — cor de cada motivo na linha do tempo dos Gráficos
//  Firestore: app_data/cores = { map: { MOTIVO: "#rrggbb" } }
//  Salvar grava só as cores alteradas (merge), sem sobrescrever o resto.
// =====================================================================
(function () {
    'use strict';

    const { CFG, norm, esc, plural, corDoMotivo, origemDaCor, vinculoDaCor, raizDaCor, db, conectar } = window.USA;
    const $ = (id) => document.getElementById(id);

    // Paleta de cores bem distintas entre si (aplicação rápida)
    const PALETA = [
        '#2d7a4c', '#e53935', '#fdd835', '#fb8c00', '#8e44ad', '#1e88e5', '#00acc1', '#ec407a',
        '#6d4c41', '#7cb342', '#3949ab', '#f4511e', '#00897b', '#c0ca33', '#5e35b1', '#757575'
    ];

    const estado = {
        salvas: {},            // app_data/cores.map
        pendentes: {},         // chave → "#hex" | null (null = voltar ao padrão)
        motivos: [],           // config.motivos
        carregado: false,
        selecionado: null,
        busca: ''
    };

    // ------------------------------------------------------------------
    //  Cores efetivas
    // ------------------------------------------------------------------
    const hex = (c) => String(c || '').toLowerCase();
    // valor salvo: "#rrggbb" (cor própria) ou "=OUTRO" (igual à cor de outro item)
    const normValor = (v) => (v == null ? null : String(v).charAt(0) === '=' ? String(v) : hex(v));

    // Cores salvas + alterações ainda não salvas
    function mapaEfetivo() {
        const m = Object.assign({}, estado.salvas);
        Object.keys(estado.pendentes).forEach((k) => {
            if (estado.pendentes[k] === null) delete m[k]; else m[k] = estado.pendentes[k];
        });
        return m;
    }
    const corAtual = (k) => corDoMotivo(k, mapaEfetivo());
    const origem = (k) => origemDaCor(k, mapaEfetivo());

    function grupos() {
        const especiais = ['PRODUTIVO', 'SEM INFORMAÇÃO'];
        const motivos = Array.from(new Set(estado.motivos.map(norm))).filter((m) => m && !especiais.includes(m)).sort();
        const usamGrupo = CFG.PROCESSOS.filter((p) => p.agruparMotivos).map((p) => p.nome);
        const nomesGrupo = CFG.GRUPOS_MOTIVO.map((g) => g.nome).concat('OUTROS').filter((g) => !motivos.includes(g));
        return [
            { titulo: 'Status', desc: 'Horas produtivas e apontamentos sem motivo', itens: especiais },
            { titulo: 'Motivos de parada', desc: 'Cadastrados em Cadastros → Motivos de parada', itens: motivos },
            { titulo: 'Grupos de motivo', desc: `Usados quando o processo agrupa motivos parecidos (${usamGrupo.join(', ') || 'nenhum'})`, itens: nomesGrupo }
        ];
    }

    // Cores iguais ou muito parecidas (distância RGB pequena)
    function rgb(h) {
        const m = /^#?([0-9a-f]{6})$/i.exec(h);
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function conflitos(chaves) {
        const res = new Map();
        const m = mapaEfetivo();
        chaves.forEach((a, i) => chaves.slice(i + 1).forEach((b) => {
            if (raizDaCor(a, m) === raizDaCor(b, m)) return;      // vinculadas de propósito: não é conflito
            const ca = rgb(corAtual(a)), cb = rgb(corAtual(b));
            if (!ca || !cb) return;
            const d = Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]);
            const tipo = d === 0 ? 'igual' : d < 45 ? 'parecida' : null;
            if (!tipo) return;
            [[a, b], [b, a]].forEach(([x, y]) => {
                if (!res.has(x) || res.get(x).tipo === 'parecida') res.set(x, { tipo, com: y });
            });
        }));
        return res;
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    function htmlItem(k, conf, todas) {
        const m = mapaEfetivo();
        const cor = corAtual(k);
        const c = conf.get(k);
        const alvo = vinculoDaCor(k, m);
        const alterado = k in estado.pendentes;
        const podeVoltar = alterado ? estado.pendentes[k] !== null : !!estado.salvas[k];
        // opções "Igual a…": todos os outros itens, menos os que já seguem este (evita ciclo)
        const opcoes = todas.filter((o) => o !== k && raizDaCor(o, m) !== k);
        return `<div class="cor-item ${estado.selecionado === k ? 'sel' : ''} ${c ? 'conf-' + c.tipo : ''} ${alvo ? 'vinculada' : ''}" data-k="${esc(k)}" tabindex="0">
            <label class="cor-amostra" style="background:${esc(cor)}" title="${alvo ? `Usa a cor de ${esc(alvo)} — escolher uma cor desfaz o vínculo` : 'Escolher cor'}">
                <input type="color" value="${esc(hex(cor))}" data-k="${esc(k)}" aria-label="Cor de ${esc(k)}">
                ${alvo ? '<span class="icone-vinculo" aria-hidden="true">🔗</span>' : ''}
            </label>
            <div class="cor-info">
                <div class="cor-nome">${esc(k)}${alterado ? ' <span class="tag-alt">alterada</span>' : ''}</div>
                <div class="cor-meta">
                    <span class="mono">${esc(hex(cor).toUpperCase())}</span>
                    <span class="${alvo ? 'origem-vinculo' : ''}">${esc(origem(k))}</span>
                    ${c ? `<span class="alerta">${c.tipo === 'igual' ? 'igual a' : 'parecida com'} ${esc(c.com)}</span>` : ''}
                </div>
                <select class="sel-igual" data-k="${esc(k)}" aria-label="Usar a mesma cor de outro item">
                    <option value="">${alvo ? 'Cor própria (desfazer vínculo)' : 'Igual a…'}</option>
                    ${opcoes.map((o) => `<option value="${esc(o)}" ${o === alvo ? 'selected' : ''}>Igual a ${esc(o)}</option>`).join('')}
                </select>
            </div>
            ${podeVoltar ? `<button type="button" class="btn-x" data-acao="padrao" data-k="${esc(k)}" title="Voltar à cor padrão">↺</button>` : ''}
        </div>`;
    }

    function render() {
        if (!estado.carregado) { $('lista').innerHTML = '<div class="card vazio">Carregando cores…</div>'; return; }

        const gs = grupos();
        const todas = gs.flatMap((g) => g.itens);
        const conf = conflitos(todas);
        const busca = estado.busca;

        $('lista').innerHTML = gs.map((g) => {
            const itens = g.itens.filter((k) => !busca || k.includes(busca));
            if (!itens.length) return '';
            return `<section class="card painel grupo-cores">
                <div class="grupo-cab"><h3>${esc(g.titulo)}</h3><span>${esc(g.desc)}</span></div>
                <div class="grade-cores">${itens.map((k) => htmlItem(k, conf, todas)).join('')}</div>
            </section>`;
        }).join('') || `<div class="card vazio">Nenhum motivo encontrado para “${esc(busca)}”.</div>`;

        // Prévia como na legenda dos Gráficos
        $('previa').innerHTML = todas.map((k) =>
            `<span class="chip"><span class="cor" style="background:${esc(corAtual(k))}"></span>${esc(k)}</span>`).join('');

        // Faixa de status
        const iguais = new Set(Array.from(conf.entries()).filter(([, v]) => v.tipo === 'igual').map(([k]) => k)).size;
        const parecidas = new Set(Array.from(conf.entries()).filter(([, v]) => v.tipo === 'parecida').map(([k]) => k)).size;
        const st = $('status-dia');
        if (!iguais && !parecidas) {
            st.className = 'status-dia ok';
            $('status-titulo').textContent = 'Todas as cores são distintas';
            $('status-sub').textContent = `${plural(todas.length, 'item', 'itens')} com cor definida`;
        } else {
            st.className = `status-dia ${iguais ? 'parado' : 'parcial'}`;
            $('status-titulo').textContent = [iguais && `${iguais} com cor repetida`, parecidas && `${parecidas} com cor parecida`].filter(Boolean).join(' · ');
            $('status-sub').textContent = 'Cores iguais ou muito próximas dificultam ler a linha do tempo. Os itens estão marcados abaixo.';
        }

        // Barra de salvar
        const n = Object.keys(estado.pendentes).length;
        $('barra-salvar').hidden = !n;
        $('n-pendentes').textContent = plural(n, 'alteração não salva', 'alterações não salvas');
    }

    function renderPaleta() {
        $('paleta').innerHTML = PALETA.map((c) =>
            `<button type="button" class="paleta-cor" style="background:${c}" data-cor="${c}" title="${c.toUpperCase()}" aria-label="Aplicar ${c}"></button>`).join('');
    }

    // ------------------------------------------------------------------
    //  Edição
    // ------------------------------------------------------------------
    // valor: "#rrggbb", "=OUTRO" (vínculo) ou null (voltar ao padrão)
    function definir(k, valor) {
        const salva = normValor(estado.salvas[k]);
        const v = normValor(valor);
        if (v === null) {
            if (salva) estado.pendentes[k] = null; else delete estado.pendentes[k];
        } else if (v === salva) {
            delete estado.pendentes[k];
        } else {
            estado.pendentes[k] = v;
        }
        render();
    }

    function selecionar(k) {
        estado.selecionado = k;
        document.querySelectorAll('.cor-item').forEach((el) => el.classList.toggle('sel', el.dataset.k === k));
        $('paleta-alvo').textContent = k ? `Aplicar em: ${k}` : 'Selecione um item para aplicar uma cor da paleta';
    }

    function salvar() {
        const alteracoes = {};
        Object.entries(estado.pendentes).forEach(([k, v]) => {
            alteracoes[k] = v === null ? firebase.firestore.FieldValue.delete() : v;
        });
        if (!Object.keys(alteracoes).length) return;
        const btn = $('btn-salvar');
        btn.disabled = true; btn.textContent = 'Salvando…';
        db().collection('app_data').doc('cores').set({ map: alteracoes }, { merge: true })
            .then(() => {
                estado.pendentes = {};
                $('aviso').className = 'aviso ok';
                $('aviso').textContent = `Cores salvas às ${new Date().toLocaleTimeString('pt-BR')}. Os gráficos já usam as novas cores.`;
                render();
            })
            .catch((e) => {
                console.error(e);
                $('aviso').className = 'aviso erro';
                $('aviso').textContent = 'Não foi possível salvar. Verifique a conexão e tente de novo.';
            })
            .finally(() => { btn.disabled = false; btn.textContent = 'Salvar cores'; });
    }

    function setStatus(classe, texto) {
        $('status-conexao').className = `pill status-conexao ${classe}`;
        $('status-texto').textContent = texto;
    }

    // ------------------------------------------------------------------
    //  Inicialização
    // ------------------------------------------------------------------
    function iniciar() {
        renderPaleta();
        const alvo = norm(new URLSearchParams(location.search).get('m'));

        const lista = $('lista');
        lista.addEventListener('input', (e) => {
            if (e.target.type !== 'color') return;
            // Atualiza só a amostra enquanto arrasta; o render completo vem no "change"
            e.target.parentElement.style.background = e.target.value;
        });
        lista.addEventListener('change', (e) => {
            if (e.target.type === 'color') { selecionar(e.target.dataset.k); definir(e.target.dataset.k, e.target.value); }
            if (e.target.classList.contains('sel-igual')) {
                const k = e.target.dataset.k, alvo = e.target.value;
                selecionar(k);
                // "Cor própria": mantém a cor que estava aparecendo, agora sem vínculo
                definir(k, alvo ? `=${alvo}` : corAtual(k));
            }
        });
        lista.addEventListener('click', (e) => {
            if (e.target.classList.contains('sel-igual')) return;     // abrir a lista não re-renderiza
            const b = e.target.closest('[data-acao="padrao"]');
            if (b) { definir(b.dataset.k, null); return; }
            const item = e.target.closest('.cor-item');
            if (item) selecionar(item.dataset.k);
        });
        $('paleta').addEventListener('click', (e) => {
            const b = e.target.closest('[data-cor]');
            if (!b) return;
            if (!estado.selecionado) { $('paleta-alvo').textContent = 'Clique primeiro num item da lista'; return; }
            definir(estado.selecionado, b.dataset.cor);
        });
        $('busca').addEventListener('input', (e) => { estado.busca = norm(e.target.value); render(); });
        $('btn-salvar').addEventListener('click', salvar);
        $('btn-descartar').addEventListener('click', () => {
            if (confirm('Descartar as alterações não salvas?')) { estado.pendentes = {}; render(); }
        });
        window.addEventListener('beforeunload', (e) => {
            if (Object.keys(estado.pendentes).length) { e.preventDefault(); e.returnValue = ''; }
        });

        let primeira = true;
        const pronto = () => {
            render();
            if (primeira && alvo && estado.carregado) {
                primeira = false;
                selecionar(alvo);
                const el = document.querySelector(`.cor-item[data-k="${CSS.escape(alvo)}"]`);
                if (el) el.scrollIntoView({ block: 'center' });
            }
        };
        let temCores = false, temConfig = false;
        conectar({
            onCores: (mapa) => {
                estado.salvas = mapa;
                // Descarta pendências que agora coincidem com o salvo
                Object.keys(estado.pendentes).forEach((k) => {
                    if (estado.pendentes[k] !== null && normValor(mapa[k]) === estado.pendentes[k]) delete estado.pendentes[k];
                });
                temCores = true; estado.carregado = temCores && temConfig;
                setStatus('online', `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
                pronto();
            },
            onConfig: (cfg) => {
                estado.motivos = cfg.motivos || [];
                temConfig = true; estado.carregado = temCores && temConfig;
                pronto();
            },
            onErro: () => setStatus('erro', 'Sem conexão')
        });
        render();
    }

    window.USA_CORES = { _estado: estado, conflitos, corAtual, grupos, definir };
    document.addEventListener('DOMContentLoaded', iniciar);
})();
