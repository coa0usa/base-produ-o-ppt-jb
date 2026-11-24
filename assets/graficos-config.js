// =====================================================================
//  CONFIGURAÇÃO DOS GRÁFICOS POR PROCESSO
//  O MENU de processos mostra SOMENTE o que está salvo em "⚙️ Cadastros".
//  Este arquivo só define as REGRAS de cada processo:
//    - horário de início do turno
//    - casas decimais / unidade
//    - agrupamento de motivos, deduplicação, ícone
//  Processo cadastrado que não está na lista abaixo usa as opções de PADRAO.
// =====================================================================
window.GRAFICOS_CONFIG = {

    // Valores usados quando o processo não define a opção
    PADRAO: {
        icone: "📊",
        inicioTurno: 5,          // hora em que o dia operacional começa (05h → 04h do dia seguinte)
                                 // ATENÇÃO: o turno cadastrado em Cadastros → Processos (início/fim)
                                 // tem prioridade sobre este arquivo.
        filtro: "igual",         // "igual" = nome do processo idêntico | "contem" = nome contém o texto
        deduplicar: false,       // true = mantém só 1 registro por frota + data + hora
        agruparMotivos: false,   // true = junta motivos parecidos (ver GRUPOS_MOTIVO)
        decimais: 1,
        unidade: "HA"            // unidade exibida nos totais (Gráficos e Resumo PPT)
    },

    // Regras por processo (o nome deve ser igual ao do Cadastro; maiúsc./minúsc. não importa)
    PROCESSOS: [
        { nome: "HERBICIDA",              icone: "🌿" },
        { nome: "PREPARO DE SOLO",        icone: "🚜", agruparMotivos: true },
        { nome: "PLANTIO MECANIZADO",     icone: "🌱", inicioTurno: 15, filtro: "contem", deduplicar: true },
        { nome: "PLANTIO MEIOSE",         icone: "🌱", inicioTurno: 15, filtro: "contem", deduplicar: true },
        { nome: "PLANTIO TORTA",          icone: "🟫" },
        { nome: "PLANTIO DESDOBRA",       icone: "🌱" },
        { nome: "PLANTIO LINHA MÃE",      icone: "🌱" },
        { nome: "IRRIGAÇÃO LINHA MÃE",    icone: "💧", decimais: 2 },
        { nome: "LINHA MÃE",              icone: "🛰️", decimais: 2, deduplicar: true },
        { nome: "ADUBAÇÃO",               icone: "🧪" },
        { nome: "ADUBAÇÃO/DESENLEIRADOR", icone: "⚙️", agruparMotivos: true },
        { nome: "DESENLEIRADOR",          icone: "🧪" },
        { nome: "VINHAÇA ASPERSÃO",       icone: "💧", unidade: "M³ / HA" },
        { nome: "VINHAÇA LOCALIZADA",     icone: "📍", unidade: "M³ / HA" },
        { nome: "SOLIX",                  icone: "🤖" }
    ],

    // Frotas renomeadas na exibição
    FROTA_ALIAS: {
        "TREMINHÃO II": "TRETAMINHÃO"
    },

    // Frotas com linha destacada na tabela (busca por "contém")
    FROTAS_DESTAQUE: ["TRETAMINHÃO", "PENTAMINHÃO"],

    // Operações que não entram no total por operação
    OPERACOES_PARADA: ["PARADO", "OPERAÇÃO PARADA"],

    // Cores usadas só quando o motivo não está no Gestor de Cores
    CORES_PADRAO: {
        "PRODUTIVO": "#2D7A4C",
        "MANUTENCAO MEC.": "#FF0000",
        "REFEICAO/CAFE": "#FFFF00",
        "ABAST. / LUBRIFICACAO": "#FF9800",
        "TROCA DE TURNO": "#8E44AD",
        "MUDANCA DE AREA - PRANCHA": "#FF69B4",
        "AGUARD. PRANCHA": "#95A5A6",
        "SOLO UMIDO - CHUVA": "#0000FF",
        "MUITO VENTO": "#00BCD4",
        "NECESSIDADE FISIOLOGICA": "#795548",
        "ACIDENTE": "#D32F2F",
        "OPORTUNIDADE": "#00BCD4",
        "SEM INFORMAÇÃO": "#95A5A6",
        // grupos (agruparMotivos)
        "MANUTENÇÃO": "#FF0000",
        "CLIMA / SOLO": "#0000FF",
        "REFEIÇÃO": "#FFFF00",
        "MUDANÇA DE ÁREA": "#FF69B4",
        "ABASTECIMENTO": "#FF9800",
        "AGUARDANDO": "#95A5A6",
        "FALTA DE OPER / MOTORISTA": "#8B4513",
        "OUTROS": "#34495E"
    },

    // Usado quando agruparMotivos = true e o motivo exato não tem cor no Gestor.
    // A primeira regra que casar vence.
    GRUPOS_MOTIVO: [
        { nome: "FALTA DE OPER / MOTORISTA", termos: ["MOTORISTA", "OPERADOR", "FALTA DE OPER"] },
        { nome: "MANUTENÇÃO",                termos: ["MECAN", "MANUTEN", "CONSERTO", "OFICINA"] },
        { nome: "CLIMA / SOLO",              termos: ["CLIMA", "CHUVA", "SOLO", "UMIDADE"] },
        { nome: "ABASTECIMENTO",             termos: ["ABASTEC"] },
        { nome: "REFEIÇÃO",                  termos: ["REFEI", "ALMO", "JANTA", "CAFE"] },
        { nome: "MUDANÇA DE ÁREA",           termos: ["DESLOC", "TROCA", "AREA", "TALHAO", "MUDANCA"] },
        { nome: "AGUARDANDO",                termos: ["AGUARDA", "ESPERA", "PARADO", "OCIOSO"] }
    ]
};
