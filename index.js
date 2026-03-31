require('dotenv').config();
const fs = require('fs');
const winston = require('winston');
const { Telegraf } = require('telegraf')
const ActualManager = require('./actualManager');
const express = require('express');
const axios = require('axios');
const helpers = require('./helpers');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.align(),
        winston.format.printf(({ timestamp, level, message }) => '[' + timestamp + '] [' + level + ']: ' + message)
    ),
    transports: [ new winston.transports.Console() ]
});

console.log = (...args) => logger.debug(args.join(' '));
console.info = (...args) => logger.info(args.join(' '));
console.warn = (...args) => logger.warn(args.join(' '));
console.error = (...args) => logger.error(args.join(' '));
console.debug = (...args) => logger.debug(args.join(' '));

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { logger.error('Falta BOT_TOKEN.'); process.exit(1); }

const USER_IDS = process.env.USER_IDS ? process.env.USER_IDS.split(',').map(id => parseInt(id.trim(), 10)) : [];
if (!USER_IDS.length) { logger.error('Falta USER_IDS.'); process.exit(1); }

const ACTUAL_USER_RENE = parseInt(process.env.ACTUAL_USER_RENE, 10) || 0;
const ACTUAL_USER_DANI = parseInt(process.env.ACTUAL_USER_DANI, 10) || 0;
const INPUT_API_KEY = process.env.INPUT_API_KEY || '';
const USE_POLLING = process.env.USE_POLLING === 'true';
const INPUT_API_USER = 'InputAPIUser';

const VERBOSITY = { SILENT: 0, MINIMAL: 1, NORMAL: 2, VERBOSE: 3 };
const BOT_VERBOSITY = VERBOSITY[process.env.BOT_VERBOSITY?.toUpperCase()] ?? VERBOSITY.NORMAL;

let BASE_URL = '';
if (!USE_POLLING) {
    try {
        BASE_URL = helpers.validateAndTrimUrl(process.env.BASE_URL);
    } catch (error) {
        logger.error('BASE_URL inválida. Usa USE_POLLING=true o proporciona una URL válida.');
        process.exit(1);
    }
}

const PORT = parseInt(process.env.PORT, 10) || 5007;

const INTRO_DEFAULT = 'Este es un bot privado para registrar transacciones en Actual Budget.\n\nTu User ID es %USER_ID%.';
const INTRO = '¡Hola! Envíame información sobre una transacción y la procesaré.\n\nComandos:\n/balance - Ver balance compartido\n/liquidar - Resetear el balance\n\nPara gastos compartidos agrega @split:\n  Tacos 400 @split';

const ACTUAL_API_ENDPOINT = process.env.ACTUAL_API_ENDPOINT;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD;
const ACTUAL_SYNC_ID = process.env.ACTUAL_SYNC_ID;
const ACTUAL_SYNC_ID_2 = process.env.ACTUAL_SYNC_ID_2 || '';
const ACTUAL_DATA_DIR = process.env.ACTUAL_DATA_DIR || '/app/data';
const ACTUAL_CURRENCY = process.env.ACTUAL_CURRENCY || 'MXN';
const ACTUAL_DEFAULT_ACCOUNT = process.env.ACTUAL_DEFAULT_ACCOUNT || 'Efectivo';
const ACTUAL_DEFAULT_ACCOUNT_DANI = process.env.ACTUAL_DEFAULT_ACCOUNT_DANI || 'Efectivo';
const ACTUAL_DEFAULT_CATEGORY = process.env.ACTUAL_DEFAULT_CATEGORY || 'Estilo de Vida';
const ACTUAL_NOTE_PREFIX = process.env.ACTUAL_NOTE_PREFIX || '🤖';
const ACTUAL_BALANCE_ACCOUNT = process.env.ACTUAL_BALANCE_ACCOUNT || 'Balance René-Dani';

if (!ACTUAL_API_ENDPOINT || !ACTUAL_PASSWORD || !ACTUAL_SYNC_ID) {
    logger.error('Falta configuración de Actual API. Saliendo...');
    process.exit(1);
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_ENDPOINT = process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TEMPERATURE = parseFloat(process.env.OPENAI_TEMPERATURE) || 0.2;

if (!OPENAI_API_KEY) { logger.error('Falta OPENAI_API_KEY.'); process.exit(1); }

let OPENAI_PROMPT_PATH = './ruleset/default.prompt';
try {
    const customPromptPath = './ruleset/custom.prompt';
    if (fs.existsSync(customPromptPath) && fs.statSync(customPromptPath).size > 0) {
        OPENAI_PROMPT_PATH = customPromptPath;
    }
} catch (error) { logger.error('Error al verificar prompt personalizado:', error); process.exit(1); }

let OPENAI_PROMPT = '';
try {
    OPENAI_PROMPT = fs.readFileSync(OPENAI_PROMPT_PATH, 'utf8').trim();
} catch (err) { logger.error('Error al cargar prompt:', err); process.exit(1); }

let OPENAI_RULES_PATH = './ruleset/default.rules';
try {
    const customRulesPath = './ruleset/custom.rules';
    if (fs.existsSync(customRulesPath) && fs.statSync(customRulesPath).size > 0) {
        OPENAI_RULES_PATH = customRulesPath;
    }
} catch (error) { logger.error('Error al verificar reglas personalizadas:', error); process.exit(1); }

let OPENAI_RULES = [];
try {
    OPENAI_RULES = fs.readFileSync(OPENAI_RULES_PATH, 'utf8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
} catch (err) { logger.error('Error al cargar reglas:', err); process.exit(1); }

const envSettings = {
    GENERAL: { BOT_TOKEN: helpers.obfuscate(BOT_TOKEN), USE_POLLING, PORT, LOG_LEVEL: LOG_LEVEL.toUpperCase(), USER_IDS, ACTUAL_USER_RENE, ACTUAL_USER_DANI, BOT_VERBOSITY: Object.keys(VERBOSITY).find(k => VERBOSITY[k] === BOT_VERBOSITY) },
    OPEN_AI: { OPENAI_API_KEY: helpers.obfuscate(OPENAI_API_KEY), OPENAI_API_ENDPOINT, OPENAI_MODEL, OPENAI_TEMPERATURE, OPENAI_PROMPT_PATH, OPENAI_RULES_PATH },
    ACTUAL: { ACTUAL_API_ENDPOINT, ACTUAL_PASSWORD: helpers.obfuscate(ACTUAL_PASSWORD), ACTUAL_SYNC_ID, ACTUAL_SYNC_ID_2: ACTUAL_SYNC_ID_2 ? helpers.obfuscate(ACTUAL_SYNC_ID_2) : '(no configurado)', ACTUAL_CURRENCY, ACTUAL_DEFAULT_ACCOUNT, ACTUAL_DEFAULT_ACCOUNT_DANI, ACTUAL_DEFAULT_CATEGORY, ACTUAL_DATA_DIR, ACTUAL_NOTE_PREFIX, ACTUAL_BALANCE_ACCOUNT }
};
logger.info('=== Configuración de inicio ===\n' + helpers.prettyjson(envSettings));

if (INPUT_API_KEY.length < 16) {
    logger.warn('INPUT_API_KEY debe tener al menos 16 caracteres. El endpoint /input estará deshabilitado.');
}

function InitActualManager() {
    const budgets = { rene: { syncId: ACTUAL_SYNC_ID, dataDir: ACTUAL_DATA_DIR } };
    if (ACTUAL_SYNC_ID_2) {
        budgets.dani = { syncId: ACTUAL_SYNC_ID_2, dataDir: ACTUAL_DATA_DIR + '_dani' };
        logger.info('Modo dual budget activado (René + Dani).');
    } else {
        logger.warn('ACTUAL_SYNC_ID_2 no configurado. Solo se usará el budget de René.');
    }
    return new ActualManager({ serverURL: ACTUAL_API_ENDPOINT, password: ACTUAL_PASSWORD, budgets });
}

function InitApp() {
    const App = express();
    App.use(express.json());
    return App;
}

function InitBot() {
    try {
        const Bot = new Telegraf(BOT_TOKEN);
        Bot.catch((err, ctx) => { logger.error('Error global de Telegraf:', err); });
        return Bot;
    } catch (error) {
        logger.error('Error al inicializar Telegraf: ' + error.message);
        process.exit(1);
    }
}

async function LaunchBot(Bot) {
    if (USE_POLLING) {
        try { await Bot.telegram.deleteWebhook({ drop_pending_updates: true }); } catch (err) { logger.warn('deleteWebhook falló: ' + err); }
        try { Bot.launch(); logger.debug('Polling activado.'); } catch (err) { logger.error('Error al iniciar polling:', err); process.exit(1); }
    } else {
        try { await Bot.telegram.setWebhook(BASE_URL + '/webhook'); logger.debug('Webhook configurado.'); } catch (err) { logger.error('Error al configurar webhook:', err); process.exit(1); }
    }
    logger.info('Conectado a Telegram correctamente.');
}

process.on('unhandledRejection', (reason, promise) => { logger.error('Rechazo no manejado:', reason); process.exit(1); });
process.on('uncaughtException', (err) => { logger.error('Excepción no capturada:', err); process.exit(1); });

async function convertCurrency(amount, fromCurrency, toCurrency, apiDate, rate = undefined) {
    if (fromCurrency.toLowerCase() === toCurrency.toLowerCase()) return parseFloat(amount.toFixed(2));
    if (rate !== undefined) return parseFloat((amount * rate).toFixed(2));
    const apiUrl = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@' + apiDate + '/v1/currencies/' + fromCurrency.toLowerCase() + '.json';
    try {
        const response = await axios.get(apiUrl);
        const rates = response.data[fromCurrency.toLowerCase()];
        if (!rates || !rates[toCurrency.toLowerCase()]) throw new Error('Tasa no encontrada para ' + fromCurrency + ' a ' + toCurrency);
        return parseFloat((amount * rates[toCurrency.toLowerCase()]).toFixed(2));
    } catch (error) {
        logger.error('Error al convertir moneda:', error);
        throw new Error('No se pudo convertir la moneda');
    }
}

module.exports = {
    InitApp, InitBot, LaunchBot, InitActualManager, convertCurrency, helpers, logger, VERBOSITY, INPUT_API_USER,
    config: {
        LOG_LEVEL, PORT, USER_IDS, BOT_VERBOSITY, INPUT_API_KEY, INTRO_DEFAULT, INTRO,
        ACTUAL_CURRENCY, ACTUAL_DEFAULT_ACCOUNT, ACTUAL_DEFAULT_ACCOUNT_DANI, ACTUAL_DEFAULT_CATEGORY,
        ACTUAL_NOTE_PREFIX, ACTUAL_BALANCE_ACCOUNT, ACTUAL_USER_RENE, ACTUAL_USER_DANI, ACTUAL_SYNC_ID_2,
        OPENAI_API_KEY, OPENAI_API_ENDPOINT, OPENAI_MODEL, OPENAI_TEMPERATURE, OPENAI_PROMPT, OPENAI_RULES
    },
};
