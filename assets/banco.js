// =====================================================================
//  BANCO DE DADOS — lançamento e manutenção dos apontamentos
//
//  Armazenamento por dia (leve e sem limite de histórico):
//    apontamentos/{aaaa-mm-dd} = { registros: { <id>: { data, hora, eq, proc, oper,
//                                                        faz, status, motivo, qtd, obs,
//                                                        criadoEm, atualizadoEm } } }
//  Cada gravação altera só o registro dela (merge), então vários usuários
//  podem lançar ao mesmo tempo sem apagar o trabalho um do outro.
//
//  Base antiga: app_data/dados.list (um documento só, limite de 1 MB).
//  A página oferece a migração; a base antiga não é apagada automaticamente.
// =====================================================================
(function () {
    'use strict';

    const {
        CFG, configDoProcesso,
        pad, norm, esc, fmt, num, plural,
        hojeISO, somarDiasISO, isoParaBR, diaDaSemana, normalizarDataBR,
        db, conectar, ouvirApontamentos, lerPeriodo, modoArmazenamento,
        diaDoRegistro, registrosDoDoc, COL_APONTAMENTOS, normalizarFazenda,
        horasDoTurno, horasDaRegra, horasDevidas, noDiaOperacional, corDoMotivo, aoMudarTurnos
    } = window.USA;

    const UI_KEY = 'usa_banco_ui';
    const $ = (id) => document.getElementById(id);

    // ------------------------------------------------------------------
    //  Dia operacional — mesma regra dos Gráficos:
    //  o dia D vai das <início do turno>h de D até antes desse horário em D+1.
    //  Ex.: turno 05h → 05h…23h gravadas com data D, 00h…04h gravadas com data D+1.
    // ------------------------------------------------------------------
    const TURNO_PAGINA = () => CFG.PADRAO.inicioTurno;                 // grade e tabela da página
    const regraPagina = () => configDoProcesso('');                    // turno padrão, 24h
    const regraDe = (proc) => configDoProcesso(proc || '');           // turno cadastrado do processo
    const turnoDe = (proc) => regraDe(proc).inicioTurno;
    const dataCivil = (diaOp, hora, ini) => (parseInt(hora, 10) < ini ? somarDiasISO(diaOp, 1) : diaOp);
    const diaOperacionalDe = (r, ini) => (parseInt(r.hora, 10) < ini ? somarDiasISO(diaDoRegistro(r), -1) : diaDoRegistro(r));
    const ordemNoTurno = (hora, ini) => (parseInt(hora, 10) - ini + 24) % 24;

    // Chave de cor igual à dos Gráficos (cores do Gestor de Cores)
    const chaveCor = (r) => (norm(r.status) === 'PRODUTIVO' ? 'PRODUTIVO' : (norm(r.motivo) || 'SEM INFORMAÇÃO'));
    const corDe = (r) => corDoMotivo(chaveCor(r), estado.cores);
    const FV = () => firebase.firestore.FieldValue;
    const colDias = () => db().collection(COL_APONTAMENTOS);

    const estado = {
        dia: null,              // dia operacional exibido (aaaa-mm-dd)
        registros: null,        // registros do dia operacional exibido
        cores: {},              // Gestor de Cores
        frotaDia: null,         // (formulário) horas já lançadas da frota
        modo: null,             // 'dia' | 'legado'
        config: { processos: [], operacoes: {}, motivos: [] },
        busca: '',
        cancelar: null,
        configCarregada: false,
        acaoInicial: null,      // { dia, eq, hora, proc, editar } vindo do clique no gráfico
        voltar: false,          // ao fechar o formulário, volta para a página anterior (Gráficos)
        cacheDias: {}           // dia → registros (para horas ocupadas / última info)
    };

    // ------------------------------------------------------------------
    //  Regras de lançamento
    // ------------------------------------------------------------------
    const ehVinhacaAspersao = (proc) => norm(proc) === 'VINHAÇA ASPERSÃO';   // quantidade digitada é ÷ 100
    const passoQtd = (proc, oper) =>
        ((norm(proc) === 'IRRIGAÇÃO LINHA MÃE' || norm(proc) === 'LINHA MÃE') && norm(oper) === 'IRRIGAR') ? '0.01' : '0.1';
    const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const isoParaInputBR = (iso) => isoParaBR(iso);

    // ------------------------------------------------------------------
    //  Leitura
    // ------------------------------------------------------------------
    function abrirDia(dia) {
        estado.dia = dia;
        estado.registros = null;
        try { localStorage.setItem(UI_KEY, JSON.stringify({ dia })); } catch (e) { /* ok */ }
        if (estado.cancelar) estado.cancelar();
        render();
        const seguinte = somarDiasISO(dia, 1);
        estado.cancelar = ouvirApontamentos([dia, seguinte], (lista, modo) => {
            estado.modo = modo;
            // guarda cada data civil no cache (usado pelo formulário)
            [dia, seguinte].forEach((d) => { estado.cacheDias[d] = lista.filter((r) => diaDoRegistro(r) === d); });
            estado.registros = lista.filter((r) => noDiaOperacional(r, { inicioTurno: TURNO_PAGINA() }, dia));
            setStatus('online', `Atualizado ${new Date().toLocaleTimeString('pt-BR')}`);
            render();
            executarAcaoInicial();
        }, () => setStatus('erro', 'Sem conexão'));
    }

    // Clique numa hora do gráfico → abre o lançamento (novo) ou a edição (hora já lançada)
    async function executarAcaoInicial() {
        const a = estado.acaoInicial;
        if (!a || estado.registros === null || !estado.configCarregada) return;
        estado.acaoInicial = null;

        // limpa os parâmetros da URL para não reabrir ao recarregar a página
        history.replaceState(null, '', `${location.pathname}?dia=${a.dia}`);

        const proc = (estado.config.processos || []).find((p) => norm(p) === norm(a.proc)) || a.proc;
        const regs = await registrosDoDiaOp(a.dia, turnoDe(proc));
        const existente = regs.find((r) => a.editar && r.id === a.editar) ||
            regs.find((r) => norm(r.eq) === norm(a.eq) && pad(parseInt(r.hora, 10)) === a.hora);
        if (existente) abrirForm(existente);
        else abrirForm(null, { eq: a.eq, hora: a.hora, proc });
    }

    async function registrosDoDia(dia) {
        if (estado.cacheDias[dia]) return estado.cacheDias[dia];
        const lista = await lerPeriodo(dia, dia);
        estado.cacheDias[dia] = lista;
        return lista;
    }

    // Registros de um dia operacional (dia + madrugada seguinte) segundo um início de turno
    async function registrosDoDiaOp(diaOp, ini) {
        const [a, b] = await Promise.all([registrosDoDia(diaOp), registrosDoDia(somarDiasISO(diaOp, 1))]);
        return a.concat(b).filter((r) => noDiaOperacional(r, { inicioTurno: ini }, diaOp));
    }

    // ------------------------------------------------------------------
    //  Gravação
    // ------------------------------------------------------------------
    function exigirModoNovo() {
        if (estado.modo === 'dia') return true;
        alert('Antes de lançar, faça a migração da base para o formato por dia (aviso no topo da página).');
        return false;
    }

    async function gravarRegistro(rec, original) {
        const dia = diaDoRegistro(rec);
        const id = original ? original.id : novoId();
        const agora = Date.now();
        const dados = Object.assign({}, rec, {
            criadoEm: (original && original.criadoEm) || agora,
            atualizadoEm: agora
        });
        delete dados.id; delete dados.dia;

        const lote = db().batch();
        lote.set(colDias().doc(dia), { registros: { [id]: dados } }, { merge: true });
        if (original && original.dia && original.dia !== dia) {          // mudou a data: tira do dia antigo
            lote.set(colDias().doc(original.dia), { registros: { [id]: FV().delete() } }, { merge: true });
        }
        await lote.commit();
        delete estado.cacheDias[dia];
        if (original) delete estado.cacheDias[original.dia];
    }

    function excluirRegistro(r) {
        if (!exigirModoNovo()) return;
        if (!confirm(`Excluir o apontamento de ${r.eq} às ${r.hora}h (${r.data})?`)) return;
        colDias().doc(r.dia).set({ registros: { [r.id]: FV().delete() } }, { merge: true })
            .catch((e) => { console.error(e); alert('Não foi possível excluir. Verifique a conexão.'); });
    }

    // ------------------------------------------------------------------
    //  Renderização
    // ------------------------------------------------------------------
    const porFrota = (a, b) => a.localeCompare(b, 'pt-BR', { numeric: true });

    function render() {
        const ini = TURNO_PAGINA();
        $('rel-data').textContent = estado.dia
            ? `${diaDaSemana(estado.dia)}, ${isoParaBR(estado.dia)} · dia operacional: ${pad(ini)}h de ${isoParaBR(estado.dia)} até ${pad((ini + 23) % 24)}h59 de ${isoParaBR(somarDiasISO(estado.dia, 1))}`
            : '';
        $('banner-migracao').hidden = estado.modo !== 'legado';
        $('manut-legado').hidden = estado.modo !== 'dia';

        if (estado.registros === null) {
            $('cobertura').innerHTML = '<div class="vazio">Carregando…</div>';
            $('corpo').innerHTML = '<tr><td colspan="11" class="vazio">Carregando…</td></tr>';
            return;
        }

        const regs = estado.registros;
        const frotas = Array.from(new Set(regs.map((r) => norm(r.eq)))).sort(porFrota);
        const prod = regs.filter((r) => norm(r.status) === 'PRODUTIVO').length;
        const ultimo = regs.reduce((m, r) => Math.max(m, r.atualizadoEm || r.criadoEm || 0), 0);

        $('k_reg').textContent = String(regs.length);
        $('k_frotas').textContent = String(frotas.length);
        $('k_prod').textContent = regs.length ? `${Math.round(prod / regs.length * 100)}%` : '0%';
        $('k_prod_det').innerHTML = `<b>${prod}</b> de ${plural(regs.length, 'hora', 'horas')}`;
        $('k_ult').textContent = ultimo ? new Date(ultimo).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
        $('k_ult_det').textContent = ultimo ? 'último lançamento ou edição' : 'sem horário registrado';

        renderCobertura(regs, frotas);
        renderTabela(regs);
        atualizarSugestoes(regs);
    }

    // Mesma faixa do gráfico: horas na ordem do turno, cor do motivo, listrado = sem apontamento
    function htmlTimeline(horas, celula) {
        return `<div class="tl-faixa" style="grid-template-columns:repeat(${horas.length},minmax(0,1fr))">${horas.map(celula).join('')}</div>
            <div class="tl-horas" style="grid-template-columns:repeat(${horas.length},minmax(0,1fr))">${horas.map((h) => `<span>${h}</span>`).join('')}</div>`;
    }

    function dicaRegistro(r, h) {
        const prodR = norm(r.status) === 'PRODUTIVO';
        return `${h}h · ${prodR ? `${norm(r.oper)} · ${fmt(num(r.qtd), 2)}` : `PARADO · ${norm(r.motivo) || 'SEM INFORMAÇÃO'}`}`;
    }

    function renderCobertura(regs, frotas) {
        if (!frotas.length) {
            $('cobertura').innerHTML = `<div class="vazio">Nenhum apontamento neste dia operacional. Use “+ Novo lançamento”.</div>`;
            $('cob-legenda').innerHTML = '';
            return;
        }
        const horas = horasDoTurno(TURNO_PAGINA());
        const devidas = horasDevidas(regraPagina(), estado.dia);          // horas que já chegaram
        const mapa = new Map();
        regs.forEach((r) => mapa.set(`${norm(r.eq)}|${pad(parseInt(r.hora, 10))}`, r));

        $('cobertura').innerHTML = frotas.map((f) => {
            const n = horas.slice(0, devidas).filter((h) => mapa.has(`${f}|${h}`)).length;
            const faixa = htmlTimeline(horas, (h, idx) => {
                const r = mapa.get(`${f}|${h}`);
                if (r) return `<button type="button" class="fatia" style="background:${esc(corDe(r))}" data-id="${esc(r.id || '')}" title="${esc(`${f} · ${dicaRegistro(r, h)}`)}"></button>`;
                return idx >= devidas
                    ? `<button type="button" class="fatia futura" data-novo="${esc(f)}|${h}" title="${esc(f)} · ${h}h · hora ainda não chegou"></button>`
                    : `<button type="button" class="fatia sem-apont" data-novo="${esc(f)}|${h}" title="${esc(f)} · ${h}h · sem apontamento — clique para lançar"></button>`;
            });
            return `<div class="cob-frota-linha">
                <div class="cob-frota">${esc(f)}<span class="cob-tot ${n < devidas ? 'falta' : ''}" title="horas lançadas / horas que já chegaram">${devidas ? `${n}/${devidas}` : '—'}</span></div>
                <div class="cob-tl">${faixa}</div>
            </div>`;
        }).join('');

        // legenda com as cores realmente presentes (igual à legenda dos Gráficos)
        const presentes = new Map();
        regs.forEach((r) => { const k = chaveCor(r); presentes.set(k, (presentes.get(k) || 0) + 1); });
        $('cob-legenda').innerHTML = Array.from(presentes.entries())
            .sort((a, b) => (a[0] === 'PRODUTIVO' ? -1 : b[0] === 'PRODUTIVO' ? 1 : b[1] - a[1]))
            .map(([k, n]) => `<span class="chip"><span class="cor" style="background:${esc(corDoMotivo(k, estado.cores))}"></span>${esc(k)} <b>${n}h</b></span>`)
            .join('') + `<span class="chip"><span class="cor sem-apont"></span>SEM APONTAMENTO — clique para lançar</span>`;
    }

    function renderTabela(regs) {
        const b = estado.busca;
        const ini = TURNO_PAGINA();
        const filtrados = regs
            .filter((r) => !b || [r.eq, r.faz, r.proc, r.oper, r.motivo].some((x) => norm(x).includes(b)))
            .sort((a, c) => porFrota(norm(a.eq), norm(c.eq)) || ordemNoTurno(a.hora, ini) - ordemNoTurno(c.hora, ini));
        $('cont').textContent = b ? `${filtrados.length} de ${regs.length}` : plural(regs.length, 'registro', 'registros');

        $('corpo').innerHTML = filtrados.length ? filtrados.map((r) => {
            const prodR = norm(r.status) === 'PRODUTIVO';
            const madrugada = diaDoRegistro(r) !== estado.dia;
            return `<tr>
                <td class="num">${esc(pad(parseInt(r.hora, 10)))}h${madrugada ? `<small class="madrugada">${esc(isoParaBR(diaDoRegistro(r)).slice(0, 5))}</small>` : ''}</td>
                <td class="frota-cel">${esc(norm(r.eq))}</td>
                <td>${esc(r.proc)}</td>
                <td>${esc(r.oper)}</td>
                <td>${esc(r.faz || r.fazenda)}</td>
                <td><span class="status-cor"><span class="cor" style="background:${esc(corDe(r))}"></span>${prodR ? 'Produtivo' : 'Parado'}</span></td>
                <td class="col-motivo">${prodR ? '' : esc(r.motivo)}</td>
                <td class="num">${esc(fmt(num(r.qtd), 2))}</td>
                <td class="col-obs" title="${esc(r.obs || '')}">${esc(r.obs || '')}</td>
                <td class="col-acoes">
                    <button type="button" class="btn-x editar" data-editar="${esc(r.id || '')}" title="Editar">✎</button>
                    <button type="button" class="btn-x" data-excluir="${esc(r.id || '')}" title="Excluir">✕</button>
                </td>
            </tr>`;
        }).join('') : `<tr><td colspan="10" class="vazio">${b ? 'Nenhum registro para a busca.' : 'Nenhum apontamento neste dia.'}</td></tr>`;
    }

    function atualizarSugestoes(regs) {
        const opts = (arr) => Array.from(new Set(arr.filter(Boolean))).sort().map((x) => `<option value="${esc(x)}"></option>`).join('');
        $('lista-frotas').innerHTML = opts(regs.map((r) => norm(r.eq)));
        $('lista-fazendas').innerHTML = opts(regs.map((r) => normalizarFazenda(r.faz || r.fazenda)));
    }

    // ------------------------------------------------------------------
    //  Formulário de lançamento
    // ------------------------------------------------------------------
    const f = (id) => $(`f-${id}`);
    let editando = null;     // registro original em edição (ou null = novo)

    function preencherSelects() {
        const c = estado.config;
        f('proc').innerHTML = '<option value="">Selecione o processo…</option>' +
            (c.processos || []).map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
        f('motivo').innerHTML = '<option value="">Selecione…</option>' +
            (c.motivos || []).filter((m) => norm(m) !== 'PRODUTINDO').map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
    }

    function atualizarOperacoes(valor) {
        const ops = (estado.config.operacoes || {})[f('proc').value] || [];
        f('oper').innerHTML = ops.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join('') ||
            `<option value="">${f('proc').value ? '(nenhuma operação cadastrada)' : 'Escolha o processo primeiro'}</option>`;
        if (valor) {
            if (!ops.includes(valor)) f('oper').insertAdjacentHTML('beforeend', `<option value="${esc(valor)}">${esc(valor)}</option>`);
            f('oper').value = valor;
        }
        ajustarQtd();
    }

    function ajustarQtd() {
        const proc = f('proc').value;
        f('qtd').step = passoQtd(proc, f('oper').value);
        $('unidade-qtd').textContent = proc ? configDoProcesso(proc).unidade : '';
        $('dica-qtd').textContent = ehVinhacaAspersao(proc) ? 'Vinhaça aspersão: o valor digitado é dividido por 100 ao salvar.' : '';
        atualizarDicaHora();
    }

    // Status em dois botões; o motivo só aparece quando está parado
    function definirStatus(s) {
        f('status').value = s;
        document.querySelectorAll('.status-toggle button').forEach((b) => {
            const on = b.dataset.status === s;
            b.classList.toggle('ativo', on);
            b.setAttribute('aria-checked', String(on));
        });
        const parado = s === 'PARADO';
        $('campo-motivo').hidden = !parado;
        if (!parado) f('motivo').value = '';
        if (parado && !f('qtd').value) f('qtd').value = '0';
        if (!parado && f('qtd').value === '0') f('qtd').value = '';
    }

    // Hora sugerida, na ordem do turno (igual ao gráfico):
    //  1) a seguinte ao último lançamento da frota no dia operacional;
    //  2) se o dia operacional está em andamento, a hora que acabou de fechar;
    //  3) senão, a primeira hora livre do turno.
    function horaSugerida(diaOp, ocupadas, ini, horas) {
        horas = horas || horasDoTurno(ini);
        const livre = (h) => !ocupadas.has(h);
        const lancadas = Array.from(ocupadas.keys()).sort((a, b) => horas.indexOf(a) - horas.indexOf(b));
        if (lancadas.length) {
            const prox = horas.slice(horas.indexOf(lancadas[lancadas.length - 1]) + 1).find(livre);
            if (prox) return prox;
        }
        const hAgora = new Date().getHours();
        const opAtual = hAgora >= ini ? hojeISO() : somarDiasISO(hojeISO(), -1);
        const fechadas = ordemNoTurno(hAgora, ini);          // horas do turno já encerradas
        if (diaOp === opAtual && fechadas > 0) {
            const h = horas.slice(0, fechadas).reverse().find(livre);
            if (h) return h;
        }
        return horas.find(livre) || null;
    }

    // Monta a lista de horas (ordem do turno) e a faixa da frota.
    // recalcular = true → ignora a hora do campo e sugere de novo
    async function atualizarHoras(manter, recalcular) {
        const diaOp = f('data').value;
        const eq = norm(f('eq').value);
        const regra = regraDe(f('proc').value);              // turno cadastrado do processo
        const ini = regra.inicioTurno;
        const horas = horasDaRegra(regra);
        const sel = f('hora');
        const atual = manter || (recalcular ? null : sel.value);
        const regs = diaOp ? await registrosDoDiaOp(diaOp, ini) : [];
        const daFrota = new Map(regs
            .filter((r) => eq && norm(r.eq) === eq && (!editando || r.id !== editando.id))
            .map((r) => [pad(parseInt(r.hora, 10)), r]));
        const amanha = diaOp ? isoParaBR(somarDiasISO(diaOp, 1)).slice(0, 5) : '';
        sel.innerHTML = horas.map((h) => {
            const madr = parseInt(h, 10) < ini;
            return `<option value="${h}" ${daFrota.has(h) ? 'disabled' : ''}>${h}:00${madr ? ` (${amanha})` : ''}${daFrota.has(h) ? ' — lançada' : ''}</option>`;
        }).join('');
        const naFaixa = (h) => h && horas.includes(h) && !daFrota.has(h);
        sel.value = naFaixa(atual) ? atual : (horaSugerida(diaOp, daFrota, ini, horas) || '');
        estado.frotaDia = { mapa: daFrota, horas, ini, fim: regra.fimTurno, devidas: diaOp ? horasDevidas(regra, diaOp) : 0 };
        renderFrotaDia();
        atualizarDicaHora();
        return daFrota;
    }

    // Faixa da frota no formulário: idêntica à linha do tempo do gráfico
    function renderFrotaDia() {
        const eq = norm(f('eq').value);
        const fd = estado.frotaDia;
        $('frota-dia').hidden = !eq || !f('data').value || !fd;
        if ($('frota-dia').hidden) return;
        const sel = f('hora').value;
        const lancadas = fd.horas.filter((h) => fd.mapa.has(h)).length;
        $('frota-dia-tit').innerHTML = `<b>${esc(eq)}</b> · dia operacional ${isoParaBR(f('data').value)} · turno ${pad(fd.ini)}h → ${pad(fd.fim)}h59`;
        $('frota-dia-n').textContent = `${lancadas}/${fd.devidas || 0} lançadas até agora`;
        $('frota-dia-horas').innerHTML = htmlTimeline(fd.horas, (h, idx) => {
            const r = fd.mapa.get(h);
            if (r) return `<button type="button" class="fatia ocupada" style="background:${esc(corDe(r))}" data-h="${h}" tabindex="-1" title="${esc(dicaRegistro(r, h))}"></button>`;
            const futura = idx >= fd.devidas;
            return `<button type="button" class="fatia ${futura ? 'futura' : 'sem-apont'} ${h === sel ? 'atual' : ''}" data-h="${h}" title="${h}h · ${futura ? 'ainda não chegou' : 'livre — clique para escolher'}"></button>`;
        });
    }

    // Madrugada: avisa com qual data civil será gravado
    function atualizarDicaHora() {
        const h = parseInt(f('hora').value, 10);
        const diaOp = f('data').value;
        if (isNaN(h) || !diaOp) { $('dica-hora').textContent = ''; return; }
        const ini = turnoDe(f('proc').value);
        $('dica-hora').textContent = h < ini
            ? `${pad(h)}h é madrugada: será gravado com data ${isoParaBR(somarDiasISO(diaOp, 1))}, dentro do dia operacional ${isoParaBR(diaOp)} — como no gráfico.`
            : '';
    }

    // Ao informar a frota num lançamento novo: repete o último contexto dela
    async function sugerirPelaFrota() {
        const eq = norm(f('eq').value);
        await atualizarHoras(null, !editando);
        if (editando || !eq) return;
        const diaOp = f('data').value;
        const ini = turnoDe(f('proc').value);
        let regs = (await registrosDoDiaOp(diaOp, ini)).filter((r) => norm(r.eq) === eq);
        if (!regs.length) regs = (await registrosDoDiaOp(somarDiasISO(diaOp, -1), ini)).filter((r) => norm(r.eq) === eq);
        if (!regs.length) return;
        const quando = (r) => `${diaDoRegistro(r)}${pad(parseInt(r.hora, 10))}`;
        const ult = regs.sort((a, b) => quando(a).localeCompare(quando(b)))[regs.length - 1];
        f('faz').value = normalizarFazenda(ult.faz || ult.fazenda);
        if ((estado.config.processos || []).includes(ult.proc)) { f('proc').value = ult.proc; atualizarOperacoes(ult.oper); }
        definirStatus(norm(ult.status) === 'PRODUTIVO' ? 'PRODUTIVO' : 'PARADO');
        if (f('status').value === 'PARADO') f('motivo').value = ult.motivo || '';
        await atualizarHoras(null, true);        // o processo pode ter outro turno
        limparInvalidos();
        f('qtd').focus();
    }

    function limparInvalidos() {
        document.querySelectorAll('#dlg .invalido').forEach((el) => el.classList.remove('invalido'));
    }

    async function abrirForm(original, preset) {
        if (!exigirModoNovo()) return;
        if (!(estado.config.processos || []).length) { alert('Nenhum processo cadastrado. Cadastre em Cadastros.'); return; }
        editando = original || null;
        preencherSelects();
        $('form-titulo').textContent = original ? `Editar apontamento · ${norm(original.eq)} ${pad(parseInt(original.hora, 10))}h` : 'Novo lançamento';
        $('btn-proximo').hidden = !!original;
        $('atalhos').textContent = original ? 'Esc fecha' : 'Enter salva e avança · Esc fecha';
        $('form-erro').textContent = '';
        $('form-erro').className = '';
        limparInvalidos();

        const r = original || {};
        f('data').value = original ? diaOperacionalDe(original, turnoDe(original.proc)) : (estado.dia || hojeISO());
        f('eq').value = original ? norm(r.eq) : (preset && preset.eq) || '';
        f('faz').value = normalizarFazenda(r.faz || r.fazenda || '');
        f('proc').value = (estado.config.processos || []).includes(r.proc) ? r.proc : '';
        if (original && r.proc && !(estado.config.processos || []).includes(r.proc)) {
            f('proc').insertAdjacentHTML('beforeend', `<option value="${esc(r.proc)}">${esc(r.proc)}</option>`);
            f('proc').value = r.proc;
        }
        atualizarOperacoes(r.oper);
        f('qtd').value = '';
        definirStatus(original ? (norm(r.status) === 'PRODUTIVO' ? 'PRODUTIVO' : 'PARADO') : 'PRODUTIVO');
        if (original && f('status').value === 'PARADO') {
            if (r.motivo && !Array.from(f('motivo').options).some((o) => o.value === r.motivo)) {
                f('motivo').insertAdjacentHTML('beforeend', `<option value="${esc(r.motivo)}">${esc(r.motivo)}</option>`);
            }
            f('motivo').value = r.motivo || '';
        }
        const q = num(r.qtd);
        if (original) f('qtd').value = String(ehVinhacaAspersao(r.proc) ? +(q * 100).toFixed(4) : q);
        f('obs').value = r.obs || '';
        await atualizarHoras(original ? pad(parseInt(r.hora, 10)) : preset && preset.hora, !original && !(preset && preset.hora));

        if (estado.voltar) $('atalhos').textContent = 'Ao fechar, volta para os Gráficos';
        $('dlg').showModal();
        if (original) f('qtd').focus();
        else if (preset && preset.eq) {
            await sugerirPelaFrota();
            // processo vindo do gráfico tem prioridade sobre o do último lançamento
            if (preset.proc && f('proc').value !== preset.proc) {
                if (!Array.from(f('proc').options).some((o) => o.value === preset.proc)) {
                    f('proc').insertAdjacentHTML('beforeend', `<option value="${esc(preset.proc)}">${esc(preset.proc)}</option>`);
                }
                f('proc').value = preset.proc;
                atualizarOperacoes();
            }
            if (preset.hora) await atualizarHoras(preset.hora);
            f('qtd').focus();
        } else f('eq').focus();
    }

    function lerForm() {
        const proc = f('proc').value;
        let qtd = num(f('qtd').value);
        if (ehVinhacaAspersao(proc)) qtd = qtd / 100;
        const status = f('status').value;
        return {
            // o campo é o dia operacional; a madrugada é gravada com a data do dia seguinte
            data: isoParaInputBR(dataCivil(f('data').value, f('hora').value, turnoDe(proc))),
            hora: f('hora').value,
            eq: norm(f('eq').value),
            proc,
            oper: f('oper').value,
            faz: normalizarFazenda(f('faz').value),
            status,
            motivo: status === 'PRODUTIVO' ? 'PRODUTINDO' : f('motivo').value,
            qtd,
            obs: f('obs').value.trim()
        };
    }

    async function salvarForm(proximo) {
        const rec = lerForm();
        limparInvalidos();
        const faltando = [
            [!rec.eq, 'eq', 'equipamento'], [!f('data').value, 'data', 'data'], [!rec.hora, 'hora', 'hora livre'],
            [!rec.faz, 'faz', 'fazenda'], [!rec.proc, 'proc', 'processo'],
            [rec.status === 'PARADO' && !rec.motivo, 'motivo', 'motivo da parada']
        ].filter(([falta]) => falta);
        if (faltando.length) {
            faltando.forEach(([, id]) => f(id).classList.add('invalido'));
            $('form-erro').className = '';
            $('form-erro').textContent = `Preencha: ${faltando.map((x) => x[2]).join(', ')}.`;
            f(faltando[0][1]).focus();
            return;
        }

        const btns = document.querySelectorAll('#dlg .dlg-acoes button');
        btns.forEach((b) => { b.disabled = true; });
        try {
            await gravarRegistro(rec, editando);
            if (proximo) {
                const ocupadas = await atualizarHoras(null, true);
                const horas = estado.frotaDia.horas;
                let prox = horas.slice(horas.indexOf(rec.hora) + 1).find((h) => !ocupadas.has(h));
                let aviso = '';
                if (!prox) {
                    // fim do turno: segue para o próximo dia operacional
                    f('data').value = somarDiasISO(f('data').value, 1);
                    await atualizarHoras(null, true);
                    prox = f('hora').value;
                    aviso = ` Turno completo — seguindo para o dia operacional ${isoParaBR(f('data').value)}.`;
                    if (!prox) { $('dlg').close(); alert('O próximo dia operacional também já está completo.'); return; }
                }
                f('hora').value = prox;
                renderFrotaDia();
                atualizarDicaHora();
                f('qtd').value = f('status').value === 'PARADO' ? '0' : '';
                f('obs').value = '';
                $('form-erro').className = 'ok';
                $('form-erro').textContent = `✓ ${rec.eq} ${rec.hora}h salvo. Agora: ${prox}h.${aviso}`;
                f('qtd').focus();
                f('qtd').select();
            } else {
                $('dlg').close();
            }
        } catch (e) {
            console.error(e);
            $('form-erro').textContent = e.code === 'permission-denied'
                ? 'Sem permissão para gravar na coleção "apontamentos". Ajuste as regras do Firestore.'
                : 'Não foi possível salvar. Verifique a conexão.';
        } finally {
            btns.forEach((b) => { b.disabled = false; });
        }
    }

    // ------------------------------------------------------------------
    //  Exportar / importar / excluir período
    // ------------------------------------------------------------------
    function baixar(nome, conteudo, tipo) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([conteudo], { type: tipo }));
        a.download = nome;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    const limparCSV = (v) => String(v == null ? '' : v).replace(/[;\r\n]+/g, ' ').trim();
    function paraCSV(regs) {
        const ord = regs.slice().sort((a, b) => diaDoRegistro(a).localeCompare(diaDoRegistro(b)) ||
            porFrota(norm(a.eq), norm(b.eq)) || parseInt(a.hora, 10) - parseInt(b.hora, 10));
        return '﻿Data;Hora;Equipamento;Processo;Operação;Fazenda;Status;Motivo;Qtd;Observação\n' +
            ord.map((r) => [r.data, `${pad(parseInt(r.hora, 10))}:00h`, r.eq, r.proc, r.oper, r.faz || r.fazenda, r.status, r.motivo,
                String(num(r.qtd)).replace('.', ','), r.obs].map(limparCSV).join(';')).join('\n');
    }

    function periodo() {
        const ini = $('p-ini').value, fim = $('p-fim').value;
        if (!ini || !fim || ini > fim) { alert('Informe um período válido (início ≤ fim).'); return null; }
        return [ini, fim];
    }

    async function exportar(formato) {
        const p = periodo(); if (!p) return;
        manutAviso('', 'Lendo período…');
        try {
            const regs = await lerPeriodo(p[0], p[1]);
            if (!regs.length) { manutAviso('erro', 'Nenhum registro no período.'); return; }
            const nome = `Apontamentos_${p[0]}_a_${p[1]}`;
            if (formato === 'csv') baixar(`${nome}.csv`, paraCSV(regs), 'text/csv;charset=utf-8');
            else baixar(`${nome}.json`, JSON.stringify({ formato: 'usa-apontamentos-v2', periodo: p, apontamentos: regs.map(semMeta) }), 'application/json');
            manutAviso('ok', `${regs.length.toLocaleString('pt-BR')} registros exportados.`);
        } catch (e) { console.error(e); manutAviso('erro', 'Falha ao exportar.'); }
    }

    const semMeta = (r) => { const x = Object.assign({}, r); delete x.id; delete x.dia; return x; };

    function lerArquivo(texto, extensao) {
        if (extensao === 'json') {
            const d = JSON.parse(texto);
            return Array.isArray(d) ? d : (d.apontamentos || d.storage || d.list || []);
        }
        // CSV: Data;Hora;Equipamento;Processo;Operação;Fazenda;Status;Motivo;Qtd;Observação
        return texto.split(/\r?\n/).slice(1).filter((l) => l.trim()).map((l) => l.split(';')).filter((c) => c.length >= 9).map((c) => ({
            data: c[0].trim(), hora: c[1].trim().replace(/:00h?$/i, ''), eq: norm(c[2]), proc: c[3].trim(), oper: c[4].trim(),
            faz: normalizarFazenda(c[5]), status: norm(c[6]), motivo: c[7].trim(), qtd: num(c[8].trim()), obs: (c[9] || '').trim()
        }));
    }

    // Grava agrupando por dia; registro com mesma frota+data+hora é substituído (não duplica)
    async function gravarEmLote(regs, progresso, idFixo) {
        const porDia = new Map();
        regs.forEach((r, i) => {
            const rec = semMeta(r);
            rec.hora = pad(parseInt(rec.hora, 10));
            rec.eq = norm(rec.eq);
            rec.data = normalizarDataBR(rec.data);
            rec.qtd = num(rec.qtd);
            const dia = diaDoRegistro(rec);
            if (!porDia.has(dia)) porDia.set(dia, []);
            porDia.get(dia).push({ rec, id: idFixo ? idFixo(r, i) : null });
        });
        const dias = Array.from(porDia.keys()).sort();
        let feitos = 0;
        for (const dia of dias) {
            const existentes = idFixo ? [] : registrosDoDoc(await colDias().doc(dia).get());
            const chave = (r) => `${norm(r.eq)}|${pad(parseInt(r.hora, 10))}`;
            const idPorChave = new Map(existentes.map((r) => [chave(r), r.id]));
            const mapa = {};
            porDia.get(dia).forEach(({ rec, id }) => {
                const k = chave(rec);
                const rid = id || idPorChave.get(k) || novoId();
                idPorChave.set(k, rid);
                // migração (idFixo) preserva o registro como era; importação ganha carimbo de data
                mapa[rid] = idFixo ? rec : Object.assign({ criadoEm: Date.now() }, rec, { atualizadoEm: Date.now() });
            });
            await colDias().doc(dia).set({ registros: mapa }, { merge: true });
            feitos += porDia.get(dia).length;
            if (progresso) progresso(feitos, regs.length, dia);
        }
        estado.cacheDias = {};
        return dias.length;
    }

    async function importar(ev) {
        const arq = ev.target.files[0];
        ev.target.value = '';
        if (!arq || !exigirModoNovo()) return;
        try {
            const regs = lerArquivo(await arq.text(), arq.name.split('.').pop().toLowerCase())
                .filter((r) => r && r.data && r.eq && r.hora !== undefined);
            if (!regs.length) { manutAviso('erro', 'Nenhum registro válido no arquivo.'); return; }
            const dias = new Set(regs.map(diaDoRegistro));
            if (!confirm(`Importar ${regs.length.toLocaleString('pt-BR')} registros em ${dias.size} dia(s)?\n\nRegistros da mesma frota, data e hora já existentes serão SUBSTITUÍDOS; os demais são mantidos.`)) return;
            await gravarEmLote(regs, (n, t) => manutAviso('', `Importando… ${n}/${t}`));
            manutAviso('ok', `${regs.length.toLocaleString('pt-BR')} registros importados.`);
        } catch (e) {
            console.error(e);
            manutAviso('erro', 'Erro ao importar. Verifique o formato do arquivo.');
        }
    }

    async function excluirPeriodo() {
        if (!exigirModoNovo()) return;
        const p = periodo(); if (!p) return;
        const regs = await lerPeriodo(p[0], p[1]);
        if (!regs.length) { manutAviso('erro', 'Nenhum registro no período.'); return; }
        const txt = prompt(`Isto apaga ${regs.length.toLocaleString('pt-BR')} registros de ${isoParaBR(p[0])} a ${isoParaBR(p[1])}.\nExporte um backup antes.\n\nDigite EXCLUIR para confirmar:`);
        if (txt !== 'EXCLUIR') return;
        const dias = Array.from(new Set(regs.map((r) => r.dia)));
        for (const d of dias) await colDias().doc(d).delete();
        estado.cacheDias = {};
        manutAviso('ok', `${dias.length} dia(s) excluído(s).`);
    }

    function manutAviso(tipo, txt) {
        $('manut-aviso').className = `aviso ${tipo}`;
        $('manut-aviso').textContent = txt;
    }

    // ------------------------------------------------------------------
    //  Migração da base antiga (um documento) → um documento por dia
    // ------------------------------------------------------------------
    async function infoLegado() {
        const d = await db().collection('app_data').doc('dados').get();
        const lista = d.exists ? (d.data().list || []) : [];
        return { lista, bytes: new Blob([JSON.stringify(lista)]).size };
    }

    async function mostrarInfoLegado() {
        try {
            const { lista, bytes } = await infoLegado();
            const pct = Math.round(bytes / (1024 * 1024) * 100);
            $('mig-info').innerHTML = `A base atual tem <b>${lista.length.toLocaleString('pt-BR')} registros</b> num único documento ` +
                `(<b>${(bytes / 1024).toFixed(0)} KB</b> de 1.024 KB — ${pct}% do limite do Firestore). Quando chegar a 100%, nenhum lançamento novo será gravado.`;
            $('mig-barra').style.width = `${Math.min(100, pct)}%`;
            $('mig-barra').className = pct >= 80 ? 'critico' : pct >= 50 ? 'alerta' : '';
        } catch (e) { $('mig-info').textContent = 'Não foi possível ler a base antiga.'; }
    }

    async function migrar() {
        const btn = $('btn-migrar');
        if (!confirm('Migrar a base para o formato por dia?\n\n1) Um backup JSON completo será baixado agora.\n2) Os registros serão copiados para um documento por dia.\n3) A base antiga NÃO será apagada.\n\nNão feche a página durante a migração.')) return;
        btn.disabled = true;
        try {
            const { lista } = await infoLegado();
            baixar(`BACKUP_ANTES_DA_MIGRACAO_${hojeISO()}.json`, JSON.stringify({ storage: lista, config: estado.config }), 'application/json');

            // teste de permissão antes de começar
            await db().collection('app_data').doc('meta').set({ testeEscrita: Date.now() }, { merge: true });

            // ids fixos ("m" + posição): se a migração for repetida, não duplica
            const dias = await gravarEmLote(lista, (n, t, dia) => {
                $('mig-info').textContent = `Migrando… ${n.toLocaleString('pt-BR')} de ${t.toLocaleString('pt-BR')} (dia ${dia})`;
                $('mig-barra').style.width = `${Math.round(n / t * 100)}%`;
            }, (r, i) => `m${i}`);

            // confere: lê tudo de volta e compara a contagem
            const conferidos = (await db().collection(COL_APONTAMENTOS).get()).docs.reduce((s, d) => s + Object.keys(d.data().registros || {}).length, 0);
            if (conferidos < lista.length) throw new Error(`Conferência falhou: ${conferidos} de ${lista.length}`);

            await db().collection('app_data').doc('meta').set({
                apontamentosPorDia: true, migradoEm: Date.now(), totalMigrado: lista.length, diasMigrados: dias
            }, { merge: true });
            alert(`Migração concluída: ${lista.length.toLocaleString('pt-BR')} registros em ${dias} dias.\nA página será recarregada.`);
            location.reload();
        } catch (e) {
            console.error(e);
            btn.disabled = false;
            $('mig-info').textContent = e.code === 'permission-denied'
                ? 'Sem permissão para gravar. As regras do Firestore precisam liberar a coleção "apontamentos" e o documento app_data/meta.'
                : `A migração não terminou (${e.message}). Nada foi apagado; pode tentar de novo.`;
        }
    }

    async function liberarLegado() {
        const { lista, bytes } = await infoLegado();
        if (!lista.length) { manutAviso('ok', 'A base antiga já está vazia.'); return; }
        const txt = prompt(`A base antiga ainda guarda ${lista.length.toLocaleString('pt-BR')} registros (${(bytes / 1024).toFixed(0)} KB), já copiados para o formato por dia.\nUm backup JSON será baixado antes de esvaziar.\n\nDigite LIBERAR para confirmar:`);
        if (txt !== 'LIBERAR') return;
        baixar(`BACKUP_BASE_ANTIGA_${hojeISO()}.json`, JSON.stringify({ storage: lista }), 'application/json');
        await db().collection('app_data').doc('dados').set({ list: [], arquivadoEm: Date.now(), registrosArquivados: lista.length });
        manutAviso('ok', 'Base antiga esvaziada. Backup baixado.');
    }

    // ------------------------------------------------------------------
    //  Inicialização
    // ------------------------------------------------------------------
    function setStatus(classe, texto) {
        $('status-conexao').className = `pill status-conexao ${classe}`;
        $('status-texto').textContent = texto;
    }

    function iniciar() {
        let ui = {};
        try { ui = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (e) { /* ok */ }
        const params = new URLSearchParams(location.search);
        const inicial = params.get('dia') || ui.dia || hojeISO();
        if (params.get('eq') && params.get('hora')) {
            estado.acaoInicial = {
                dia: inicial, eq: norm(params.get('eq')), hora: pad(parseInt(params.get('hora'), 10)),
                proc: params.get('proc') || '', editar: params.get('editar') || ''
            };
            estado.voltar = params.get('voltar') === '1' && history.length > 1;
        }
        $('filtro-data').value = inicial;
        $('p-ini').value = somarDiasISO(hojeISO(), -30);
        $('p-fim').value = hojeISO();

        const ir = (d) => { $('filtro-data').value = d; abrirDia(d); };
        $('filtro-data').addEventListener('change', () => abrirDia($('filtro-data').value || hojeISO()));
        $('btn-dia-ant').addEventListener('click', () => ir(somarDiasISO(estado.dia, -1)));
        $('btn-dia-prox').addEventListener('click', () => ir(somarDiasISO(estado.dia, 1)));
        $('btn-hoje').addEventListener('click', () => ir(hojeISO()));
        $('busca').addEventListener('input', (e) => { estado.busca = norm(e.target.value); if (estado.registros) renderTabela(estado.registros); });
        $('btn-novo').addEventListener('click', () => abrirForm(null));

        const acharPorId = (id) => (estado.registros || []).find((r) => r.id === id);
        $('corpo').addEventListener('click', (e) => {
            const ed = e.target.closest('[data-editar]'), ex = e.target.closest('[data-excluir]');
            if (ed) abrirForm(acharPorId(ed.dataset.editar));
            if (ex) excluirRegistro(acharPorId(ex.dataset.excluir));
        });
        $('cobertura').addEventListener('click', (e) => {
            const c = e.target.closest('.fatia');
            if (!c) return;
            if (c.dataset.id) abrirForm(acharPorId(c.dataset.id));
            else if (c.dataset.novo) { const [eq, hora] = c.dataset.novo.split('|'); abrirForm(null, { eq, hora }); }
        });

        // formulário
        f('proc').addEventListener('change', () => { atualizarOperacoes(); atualizarHoras(); });   // turno pode mudar
        f('oper').addEventListener('change', ajustarQtd);
        document.querySelector('.status-toggle').addEventListener('click', (e) => {
            const b = e.target.closest('[data-status]');
            if (!b) return;
            definirStatus(b.dataset.status);
            if (b.dataset.status === 'PARADO') f('motivo').focus();
        });
        f('eq').addEventListener('change', sugerirPelaFrota);
        f('data').addEventListener('change', () => atualizarHoras(null, !editando));
        f('hora').addEventListener('change', () => { renderFrotaDia(); atualizarDicaHora(); });
        $('frota-dia-horas').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-h]');
            if (!b || b.classList.contains('ocupada')) return;
            f('hora').value = b.dataset.h;
            renderFrotaDia();
            atualizarDicaHora();
        });
        $('form-lanc').addEventListener('input', (e) => e.target.classList.remove('invalido'));
        $('form-lanc').addEventListener('change', (e) => e.target.classList.remove('invalido'));
        $('form-lanc').addEventListener('submit', (e) => { e.preventDefault(); salvarForm(!editando); });
        $('btn-salvar').addEventListener('click', () => salvarForm(false));
        $('btn-cancelar').addEventListener('click', () => $('dlg').close());
        $('btn-fechar').addEventListener('click', () => $('dlg').close());
        // veio do gráfico: ao fechar o formulário (salvou, cancelou ou Esc), volta para lá
        $('dlg').addEventListener('close', () => {
            if (!estado.voltar) return;
            estado.voltar = false;
            history.back();
        });

        // manutenção
        $('btn-csv').addEventListener('click', () => exportar('csv'));
        $('btn-json').addEventListener('click', () => exportar('json'));
        $('btn-importar').addEventListener('click', () => $('arquivo').click());
        $('arquivo').addEventListener('change', importar);
        $('btn-excluir-periodo').addEventListener('click', excluirPeriodo);
        $('btn-migrar').addEventListener('click', migrar);
        $('btn-liberar').addEventListener('click', liberarLegado);

        conectar({
            onConfig: (cfg) => {
                estado.config = { processos: cfg.processos || [], operacoes: cfg.operacoes || {}, motivos: cfg.motivos || [] };
                estado.configCarregada = true;
                executarAcaoInicial();
            },
            onCores: (mapa) => { estado.cores = mapa; render(); },
            onErro: () => setStatus('erro', 'Sem conexão')
        });
        modoArmazenamento().then((m) => { estado.modo = m; if (m === 'legado') mostrarInfoLegado(); render(); });
        abrirDia(inicial);
    }

    window.USA_BANCO = { lerArquivo, paraCSV, passoQtd, ehVinhacaAspersao, gravarEmLote, gravarRegistro, horaSugerida,
        dataCivil, diaOperacionalDe, registrosDoDiaOp, _estado: estado };
    document.addEventListener('DOMContentLoaded', iniciar);
})();
