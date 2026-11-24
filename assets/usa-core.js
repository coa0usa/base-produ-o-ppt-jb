// =====================================================================
//  NÚCLEO COMPARTILHADO — Sistema Integrado USA
//  Utilidades, regras de dia operacional, Firestore e print.
//  Usado por Graficos.html e Resumo_PPT.html.
//  Depende de: assets/firebase-config.js e assets/graficos-config.js
// =====================================================================
(function () {
    'use strict';

    const CFG = window.GRAFICOS_CONFIG;

    // ------------------------------------------------------------------
    //  Texto e números
    // ------------------------------------------------------------------
    const pad = (n) => String(n).padStart(2, '0');
    const norm = (s) => String(s == null ? '' : s).toUpperCase().trim();
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
    const fmt = (n, casas) => Number(n || 0).toLocaleString('pt-BR', {
        minimumFractionDigits: casas, maximumFractionDigits: casas
    });
    const num = (v) => parseFloat(String(v == null ? 0 : v).replace(',', '.')) || 0;
    const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

    // ------------------------------------------------------------------
    //  Datas — input usa "aaaa-mm-dd", banco usa "dd/mm/aaaa"
    //  (nunca usar toISOString: ele converte para UTC e erra a data à noite)
    // ------------------------------------------------------------------
    function hojeISO() {
        const d = new Date();
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function somarDiasISO(iso, dias) {
        const [a, m, d] = iso.split('-').map(Number);
        const dt = new Date(a, m - 1, d + dias);
        return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
    }
    function isoParaBR(iso) {
        const [a, m, d] = iso.split('-');
        return `${d}/${m}/${a}`;
    }
    function diaDaSemana(iso) {
        const [a, m, d] = iso.split('-').map(Number);
        const s = new Date(a, m - 1, d).toLocaleDateString('pt-BR', { weekday: 'long' });
        return s.charAt(0).toUpperCase() + s.slice(1);
    }
    function normalizarDataBR(s) {
        const p = String(s || '').trim().split('/');
        return p.length === 3 ? `${pad(p[0])}/${pad(p[1])}/${p[2]}` : String(s || '').trim();
    }
    function horaDoRegistro(r) {
        const h = parseInt(r.hora, 10);
        return isNaN(h) ? null : h;
    }
    function horasDoTurno(inicio) {
        return Array.from({ length: 24 }, (_, i) => pad((inicio + i) % 24));
    }
    const fimPadrao = (inicio) => (inicio + 23) % 24;
    const fimDa = (cfg) => (Number.isInteger(cfg.fimTurno) ? cfg.fimTurno : fimPadrao(cfg.inicioTurno));

    // Horas exibidas no gráfico: do início ao fim do turno (pode atravessar a meia-noite)
    function horasDaRegra(cfg) {
        const ini = cfg.inicioTurno;
        const dur = ((fimDa(cfg) - ini + 24) % 24) + 1;
        return Array.from({ length: dur }, (_, i) => pad((ini + i) % 24));
    }
    function textoTurno(cfg) {
        return `Turno ${pad(cfg.inicioTurno)}h → ${pad(fimDa(cfg))}h59`;
    }

    // Quantas horas do turno JÁ CHEGARAM (inclui a hora atual).
    // Dia operacional passado → todas; futuro → nenhuma.
    function horasDevidas(cfg, dataISO) {
        const ini = cfg.inicioTurno;
        const total = horasDaRegra(cfg).length;
        const h = new Date().getHours();
        const opAtual = h >= ini ? hojeISO() : somarDiasISO(hojeISO(), -1);
        if (dataISO < opAtual) return total;
        if (dataISO > opAtual) return 0;
        return Math.min(total, ((h - ini + 24) % 24) + 1);
    }

    // ------------------------------------------------------------------
    //  Regras por processo
    //  Turno (início/fim): 1) cadastrado em Cadastros → Processos (Firestore)
    //                      2) graficos-config.js   3) padrão
    // ------------------------------------------------------------------
    let turnosCadastro = {};             // app_data/config.turnos = { PROCESSO: { inicio, fim } }
    const ouvintesTurno = [];
    let turnosIniciado = false;

    function aplicarTurno(cfg, chaves) {
        const t = chaves.map((k) => turnosCadastro[norm(k)]).find((x) => x && Number.isInteger(x.inicio));
        if (t) {
            cfg.inicioTurno = t.inicio;
            cfg.fimTurno = Number.isInteger(t.fim) ? t.fim : fimPadrao(t.inicio);
            cfg.turnoCadastrado = true;
        } else {
            cfg.fimTurno = Number.isInteger(cfg.fimTurno) ? cfg.fimTurno : fimPadrao(cfg.inicioTurno);
            cfg.turnoCadastrado = false;
        }
        return cfg;
    }

    // Regra para um processo escolhido no menu (nome exato)
    function configDoProcesso(nome) {
        const alvo = norm(nome);
        const p = CFG.PROCESSOS.find((x) => norm(x.nome) === alvo) || { nome: alvo };
        return aplicarTurno(Object.assign({}, CFG.PADRAO, p, { nome: alvo }), [alvo]);
    }

    // Regra para o "proc" gravado num registro: nome exato primeiro,
    // depois regras com filtro "contem" (ex.: "PLANTIO MEIOSE 2" → PLANTIO MEIOSE)
    function regraDoRegistro(procDoRegistro) {
        const p = norm(procDoRegistro);
        const exato = CFG.PROCESSOS.find((x) => norm(x.nome) === p);
        const contem = exato ? null : CFG.PROCESSOS.find((x) => x.filtro === 'contem' && p.includes(norm(x.nome)));
        const base = exato || contem || {};
        return aplicarTurno(Object.assign({}, CFG.PADRAO, base, { nome: p }), [p, base.nome || p]);
    }

    // Atualiza os turnos cadastrados e avisa as páginas (que redesenham)
    function definirTurnos(mapa) {
        turnosCadastro = {};
        Object.keys(mapa || {}).forEach((k) => { turnosCadastro[norm(k)] = mapa[k]; });
        ouvintesTurno.forEach((f) => f());
    }
    // A página pede para ser avisada quando os turnos do Cadastro carregarem/mudarem
    function aoMudarTurnos(fn) {
        ouvintesTurno.push(fn);
        if (turnosIniciado) return;
        turnosIniciado = true;
        db().collection('app_data').doc('config').onSnapshot(
            (d) => definirTurnos(d.exists ? d.data().turnos : {}),
            (e) => console.error('Turnos indisponíveis:', e)
        );
    }

    // O registro pertence ao dia operacional (dataISO) segundo o turno da regra?
    // Turno de 24h: das <início>h de D até antes desse horário em D+1.
    // Turno menor (fim cadastrado): só as horas entre início e fim.
    function noDiaOperacional(r, cfg, dataISO) {
        const h = horaDoRegistro(r);
        if (h === null) return false;
        const ini = cfg.inicioTurno;
        const d = normalizarDataBR(r.data);
        const dataOk = (d === isoParaBR(dataISO) && h >= ini) ||
                       (d === isoParaBR(somarDiasISO(dataISO, 1)) && h < ini);
        if (!dataOk) return false;
        const fim = fimDa(cfg);
        return ((h - ini + 24) % 24) <= ((fim - ini + 24) % 24);
    }

    function chaveDuplicidade(r) {
        return `${norm(r.proc)}|${norm(r.eq)}|${normalizarDataBR(r.data)}|${horaDoRegistro(r)}`;
    }

    function deduplicar(lista) {
        const unicos = new Map();
        lista.forEach((r) => unicos.set(chaveDuplicidade(r), r));
        return Array.from(unicos.values());
    }

    // Registros de UM processo (menu) no dia operacional
    function filtrarRegistros(dados, cfg, dataISO) {
        const alvo = cfg.nome;
        let lista = dados.filter((r) => {
            const p = norm(r.proc);
            if (cfg.filtro === 'contem' ? !p.includes(alvo) : p !== alvo) return false;
            return noDiaOperacional(r, cfg, dataISO);
        });
        if (cfg.deduplicar) lista = deduplicar(lista);

        // Ordena pela hora do turno
        const ordem = (r) => (horaDoRegistro(r) - cfg.inicioTurno + 24) % 24;
        return lista.sort((a, b) => ordem(a) - ordem(b));
    }

    // ------------------------------------------------------------------
    //  Cores de motivo — mesma regra em Gráficos e no Gestor de Cores:
    //  1) cor salva no Gestor  2) cor padrão do config  3) cor automática
    // ------------------------------------------------------------------
    function hslParaHex(h, s, l) {
        s /= 100; l /= 100;
        const a = s * Math.min(l, 1 - l);
        const f = (n) => {
            const k = (n + h / 30) % 12;
            return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1))).toString(16).padStart(2, '0');
        };
        return `#${f(0)}${f(8)}${f(4)}`;
    }
    function corAutomatica(texto) {
        let hash = 0;
        for (let i = 0; i < texto.length; i++) hash = texto.charCodeAt(i) + ((hash << 5) - hash);
        return hslParaHex(Math.abs(hash) % 360, 65, 45);
    }
    // Vínculo: o valor salvo "=OUTRO MOTIVO" faz este item usar a cor do outro
    // (e acompanhar quando a do outro mudar).
    function vinculoDaCor(chave, coresSalvas) {
        const v = coresSalvas && coresSalvas[chave];
        return typeof v === 'string' && v.charAt(0) === '=' ? v.slice(1) : null;
    }
    // Item final da cadeia de vínculos (A → B → C devolve C); protege contra ciclos
    function raizDaCor(chave, coresSalvas) {
        const vistos = new Set([chave]);
        let atual = chave, prox = vinculoDaCor(atual, coresSalvas);
        while (prox && !vistos.has(prox)) { vistos.add(prox); atual = prox; prox = vinculoDaCor(atual, coresSalvas); }
        return atual;
    }
    function corDoMotivo(chave, coresSalvas) {
        const k = raizDaCor(chave, coresSalvas);
        const v = coresSalvas && coresSalvas[k];
        return (v && !vinculoDaCor(k, coresSalvas) ? v : null) || CFG.CORES_PADRAO[k] || corAutomatica(k);
    }
    function origemDaCor(chave, coresSalvas) {
        const alvo = vinculoDaCor(chave, coresSalvas);
        if (alvo) return `igual a ${alvo}`;
        return (coresSalvas && coresSalvas[chave]) ? 'personalizada' : CFG.CORES_PADRAO[chave] ? 'padrão' : 'automática';
    }

    const operacaoAtiva = (oper) => oper !== 'N/A' && oper !== '' && !CFG.OPERACOES_PARADA.includes(oper);
    const nomeDaFrota = (eq) => { const e = norm(eq); return CFG.FROTA_ALIAS[e] || e || 'SEM FROTA'; };

    // ------------------------------------------------------------------
    //  Preferências da tela (localStorage tolerante a falhas)
    // ------------------------------------------------------------------
    function lerUI(chave) {
        try { return JSON.parse(localStorage.getItem(chave)) || {}; } catch (e) { return {}; }
    }
    function salvarUI(chave, valor) {
        try { localStorage.setItem(chave, JSON.stringify(valor)); } catch (e) { /* sem storage */ }
    }

    // ------------------------------------------------------------------
    //  Firestore — uma conexão, callbacks por documento
    // ------------------------------------------------------------------
    let dbInstancia = null;
    function db() {
        if (dbInstancia) return dbInstancia;
        if (!firebase.apps.length) firebase.initializeApp(window.USA_FIREBASE_CONFIG);
        dbInstancia = firebase.firestore();
        // Cache local (IndexedDB): reabrir a página não baixa tudo de novo
        try {
            if (dbInstancia.enablePersistence) dbInstancia.enablePersistence({ synchronizeTabs: true }).catch(() => {});
        } catch (e) { /* navegador sem suporte: segue sem cache */ }
        return dbInstancia;
    }

    // ------------------------------------------------------------------
    //  APONTAMENTOS — armazenamento por dia
    //    novo:   apontamentos/{aaaa-mm-dd} = { registros: { id: {...} } }
    //    legado: app_data/dados = { list: [...] }   (até a migração)
    //  app_data/meta.apontamentosPorDia = true indica que a migração foi feita.
    // ------------------------------------------------------------------
    const COL_APONTAMENTOS = 'apontamentos';
    let modoPromise = null;

    function modoArmazenamento() {
        if (!modoPromise) {
            modoPromise = db().collection('app_data').doc('meta').get()
                .then((d) => (d.exists && d.data().apontamentosPorDia ? 'dia' : 'legado'))
                .catch(() => 'legado');
        }
        return modoPromise;
    }

    // "20/11/2026" → "2026-11-20" (id do documento do dia)
    function diaDoRegistro(r) {
        const p = normalizarDataBR(r.data).split('/');
        return p.length === 3 && /^\d{4}$/.test(p[2]) ? `${p[2]}-${p[1]}-${p[0]}` : 'sem-data';
    }

    function registrosDoDoc(doc) {
        const mapa = doc.exists ? (doc.data().registros || {}) : {};
        return Object.keys(mapa).map((id) => Object.assign({}, mapa[id], { id, dia: doc.id }));
    }

    // Escuta os dias pedidos (em tempo real). Retorna função para cancelar.
    function ouvirApontamentos(diasISO, aoReceber, aoErrar) {
        let cancelado = false;
        const cancelar = [];
        const erro = (e) => { console.error(e); if (aoErrar) aoErrar(e); };
        modoArmazenamento().then((modo) => {
            if (cancelado) return;
            if (modo === 'legado') {
                cancelar.push(db().collection('app_data').doc('dados').onSnapshot((d) => {
                    const lista = d.exists ? (d.data().list || []) : [];
                    aoReceber(lista.filter((r) => diasISO.includes(diaDoRegistro(r))), modo);
                }, erro));
                return;
            }
            const porDia = {};
            diasISO.forEach((dia) => {
                cancelar.push(db().collection(COL_APONTAMENTOS).doc(dia).onSnapshot((d) => {
                    porDia[dia] = registrosDoDoc(d);
                    if (Object.keys(porDia).length === diasISO.length) {
                        aoReceber(diasISO.flatMap((x) => porDia[x]), modo);
                    }
                }, erro));
            });
        });
        return () => { cancelado = true; cancelar.forEach((f) => f()); };
    }

    // Leitura única de um período (exportação, contagens)
    async function lerPeriodo(inicioISO, fimISO) {
        const modo = await modoArmazenamento();
        if (modo === 'legado') {
            const d = await db().collection('app_data').doc('dados').get();
            const lista = d.exists ? (d.data().list || []) : [];
            return lista.filter((r) => { const x = diaDoRegistro(r); return x >= inicioISO && x <= fimISO; });
        }
        const id = firebase.firestore.FieldPath.documentId();
        const snap = await db().collection(COL_APONTAMENTOS).where(id, '>=', inicioISO).where(id, '<=', fimISO).get();
        return snap.docs.flatMap(registrosDoDoc);
    }

    // Para páginas de turno: assina o dia + o dia seguinte, trocando quando a data muda
    function assinaturaDoDiaOperacional(aoReceber, aoErrar) {
        let chave = null, cancelar = null;
        return function garantir(dataISO) {
            const dias = [dataISO, somarDiasISO(dataISO, 1)];
            if (dias.join() === chave) return false;
            if (cancelar) cancelar();
            chave = dias.join();
            cancelar = ouvirApontamentos(dias, aoReceber, aoErrar);
            return true;
        };
    }

    // Cores e cadastros (documentos pequenos). Apontamentos: use ouvirApontamentos/lerPeriodo.
    function conectar({ onCores, onConfig, onErro }) {
        const col = db().collection('app_data');
        const erro = (e) => { console.error(e); if (onErro) onErro(e); };
        if (onCores)  col.doc('cores').onSnapshot((d) => onCores(d.exists ? (d.data().map || {}) : {}), erro);
        if (onConfig) turnosIniciado = true;           // já escuta o config: aoMudarTurnos não abre outra conexão
        if (onConfig) col.doc('config').onSnapshot((d) => {
            const dados = d.exists ? d.data() : {};
            definirTurnos(dados.turnos);
            onConfig(dados, d.exists);
        }, erro);
    }

    // ------------------------------------------------------------------
    //  Print: copia PNG para a área de transferência; se o navegador
    //  bloquear (ex.: aberto via file://), baixa o arquivo.
    //  Retorna "copiado" | "baixado" | "erro".
    // ------------------------------------------------------------------
    async function gerarPrint(elemento, nomeArquivo, fundo) {
        try {
            const canvas = await html2canvas(elemento, {
                backgroundColor: fundo || '#ffffff', scale: 2, logging: false,
                windowWidth: Math.max(document.documentElement.clientWidth, elemento.scrollWidth)
            });
            const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                return 'copiado';
            } catch (e) {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `${nomeArquivo}.png`.replace(/[\\/:*?"<>| ]+/g, '_');
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
                return 'baixado';
            }
        } catch (err) {
            console.error('Erro ao gerar print:', err);
            return 'erro';
        }
    }

    window.USA = {
        CFG, pad, norm, esc, fmt, num, plural,
        hojeISO, somarDiasISO, isoParaBR, diaDaSemana, normalizarDataBR,
        horaDoRegistro, horasDoTurno, horasDaRegra, horasDevidas, textoTurno, fimPadrao,
        definirTurnos, aoMudarTurnos,
        configDoProcesso, regraDoRegistro, noDiaOperacional, deduplicar, chaveDuplicidade,
        filtrarRegistros, operacaoAtiva, nomeDaFrota,
        hslParaHex, corAutomatica, corDoMotivo, origemDaCor, vinculoDaCor, raizDaCor,
        lerUI, salvarUI, db, conectar, gerarPrint,
        COL_APONTAMENTOS, modoArmazenamento, diaDoRegistro, registrosDoDoc,
        ouvirApontamentos, lerPeriodo, assinaturaDoDiaOperacional,
        normalizarFazenda: (f) => norm(f).replace(/\s*\/\s*/g, ' - ').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim()
    };
})();
