const {
    VERBOSITY, INPUT_API_USER,
    logger, config, helpers,
    convertCurrency,
    InitApp, InitActualManager, InitBot, LaunchBot
} = require('./common/init');
const OpenAI = require('openai');

logger.info('El bot está iniciando...');

// -- Initialize ---
let App = InitApp();
let ActualMgr = InitActualManager();
let Bot = InitBot();

// -- Start Server --
App.listen(config.PORT, () => {
    logger.info('Servidor iniciado correctamente en el puerto ' + config.PORT + '.');
}).on('error', (err) => {
    logger.error('Error al iniciar el servidor. ' + err);
    process.exit(1);
});

// -- Start Bot --
LaunchBot(Bot);

// -- Helper: determine budget key from user ID --
function getBudgetKey(userId) {
    if (userId === config.ACTUAL_USER_RENE) return 'rene';
    if (userId === config.ACTUAL_USER_DANI) return 'dani';
    return 'rene';
}

// -- Helper: get default account for a user --
function getDefaultAccount(userId) {
    if (userId === config.ACTUAL_USER_DANI) return config.ACTUAL_DEFAULT_ACCOUNT_DANI;
    return config.ACTUAL_DEFAULT_ACCOUNT;
}

// -- Helper: build LLM prompt with budget data --
async function buildPrompt(userId) {
    const budgetKey = getBudgetKey(userId);
    const defaultAccount = getDefaultAccount(userId);
    const { accounts, categories, payees } = await ActualMgr.getBudgetData(budgetKey);

    return config.OPENAI_PROMPT
        .replace('%DATE%', new Date().toISOString().split('T')[0])
        .replace('%DEFAULT_ACCOUNT%', defaultAccount)
        .replace('%DEFAULT_CATEGORY%', config.ACTUAL_DEFAULT_CATEGORY)
        .replace('%CURRENCY%', config.ACTUAL_CURRENCY)
        .replace('%ACCOUNTS_LIST%', accounts.map(acc => acc.name).join(', '))
        .replace('%CATEGORY_LIST%', categories.map(cat => cat.name).join(', '))
        .replace('%PAYEE_LIST%', payees.map(payee => payee.name).join(', '))
        .replace('%RULES%', config.OPENAI_RULES.join('\n'));
}

// -- Helper: call LLM and parse response --
async function callLLM(prompt, userMessage) {
    const openai = new OpenAI({
        apiKey: config.OPENAI_API_KEY,
        baseURL: config.OPENAI_API_ENDPOINT,
    });

    logger.debug('=== Solicitud al LLM ===');
    logger.debug('Prompt:\n' + prompt);
    logger.debug('Mensaje: ' + userMessage);

    const response = await openai.chat.completions.create({
        model: config.OPENAI_MODEL,
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: userMessage },
        ],
        temperature: config.OPENAI_TEMPERATURE,
    });

    const jsonResponse = response.choices[0].message.content
        .replace(/```(?:json)?\n?|\n?```/g, '')
        .trim();

    logger.debug('=== Respuesta LLM ===');
    logger.debug(jsonResponse);

    const parsed = JSON.parse(jsonResponse);
    if (!Array.isArray(parsed)) throw new Error('La respuesta del LLM no es un array');
    return parsed;
}

// -- Helper: format balance message --
function formatBalance(balance) {
    const abs = Math.abs(balance).toFixed(2);
    if (balance > 0) return 'Dani le debe a René $' + abs + ' MXN';
    if (balance < 0) return 'René le debe a Dani $' + abs + ' MXN';
    return 'Están a mano, balance en cero 🎉';
}

// -- Unified Message Handler --
Bot.on('message', async (ctx) => {
    const userId = ctx.from?.id;
    const chatType = ctx.chat?.type;
    const messageText = ctx.message.text || ctx.message.caption;
    const userName = ctx.from?.first_name;
    logger.warn(userName);

    logger.info('Mensaje entrante del usuario: ' + userId + ', tipo de chat: ' + chatType);

    if (!messageText) return;
    if (chatType !== 'private') return;

    if (!config.USER_IDS.includes(userId)) {
        return ctx.reply(config.INTRO_DEFAULT.replace('%USER_ID%', userId));
    }

    const trimmedText = messageText.trim();

    // /start or /help
    if (trimmedText === '/start' || trimmedText === '/help') {
        logger.debug('Enviando intro al usuario ' + userId);
        return ctx.reply(config.INTRO.replace('%USER_ID%', userId));
    }

    // /balance
    if (trimmedText === '/balance') {
        try {
            const balance = await ActualMgr.getBalance(config.ACTUAL_BALANCE_ACCOUNT);
            const msg = '💰 *Balance compartido*\n' + formatBalance(balance);
            await ctx.reply(msg, { parse_mode: 'Markdown' });
            const otherId = userId === config.ACTUAL_USER_RENE ? config.ACTUAL_USER_DANI : config.ACTUAL_USER_RENE;
            if (otherId) {
                try { await Bot.telegram.sendMessage(otherId, msg, { parse_mode: 'Markdown' }); }
                catch (e) { logger.warn('No se pudo notificar al otro usuario: ' + e.message); }
            }
        } catch (err) {
            logger.error('Error al obtener balance:', err);
            await ctx.reply('Hubo un error al obtener el balance. Revisa los logs.');
        }
        return;
    }

    // /liquidar
    if (trimmedText === '/liquidar') {
        try {
            const previous = await ActualMgr.resetBalance(config.ACTUAL_BALANCE_ACCOUNT);
            const msg = previous === 0
                ? '✅ El balance ya estaba en cero.'
                : '✅ Balance liquidado. Se resetó desde: ' + formatBalance(previous);
            await ctx.reply(msg);
            const otherId = userId === config.ACTUAL_USER_RENE ? config.ACTUAL_USER_DANI : config.ACTUAL_USER_RENE;
            if (otherId) {
                try { await Bot.telegram.sendMessage(otherId, msg); }
                catch (e) { logger.warn('No se pudo notificar al otro usuario: ' + e.message); }
            }
        } catch (err) {
            logger.error('Error al liquidar balance:', err);
            await ctx.reply('Hubo un error al liquidar el balance. Revisa los logs.');
        }
        return;
    }

    // Transaction processing
    const isSplit = trimmedText.toLowerCase().includes('@split');
    const cleanText = trimmedText.replace(/@split/gi, '').trim();
    const budgetKey = getBudgetKey(userId);

    // Call LLM
    let parsedResponse;
    try {
        const prompt = await buildPrompt(userId);
        parsedResponse = await callLLM(prompt, cleanText);
        if (parsedResponse.length === 0) {
            return ctx.reply('No encontré información para crear transacciones. ¿Puedes intentar de nuevo?',
                userName === INPUT_API_USER ? {} : { reply_to_message_id: ctx.message.message_id });
        }
    } catch (err) {
        logger.error('Error al obtener/parsear respuesta del LLM:', err);
        return ctx.reply('Hubo un error procesando tu mensaje. Intenta de nuevo.',
            userName === INPUT_API_USER ? {} : { reply_to_message_id: ctx.message.message_id });
    }

    // Create transactions
    try {
        let replyMessage = '';
        if (config.BOT_VERBOSITY === VERBOSITY.VERBOSE) {
            replyMessage = '*[RESPUESTA LLM]*\n```\n' + helpers.prettyjson(parsedResponse) + '\n```\n\n';
        }
        replyMessage += '*[TRANSACCIONES]*\n';

        let added = 0;

        for (const tx of parsedResponse) {
            if (!tx.amount) continue;

            const defaultAccount = getDefaultAccount(userId);
            const accountName = tx.account || defaultAccount;
            const categoryName = tx.category || config.ACTUAL_DEFAULT_CATEGORY;
            const date = tx.date || new Date().toISOString().split('T')[0];
            const apiDate = date === new Date().toISOString().split('T')[0] ? 'latest' : date;

            let amount = tx.amount;
            if (tx.currency && tx.currency.toLowerCase() !== config.ACTUAL_CURRENCY.toLowerCase()) {
                amount = await convertCurrency(tx.amount, tx.currency, config.ACTUAL_CURRENCY, apiDate, tx.exchange_rate);
            } else {
                tx.currency = config.ACTUAL_CURRENCY;
            }

            const notes = (config.ACTUAL_NOTE_PREFIX + ' ' + (tx.notes || tx.payee || '')).trim();

            if (isSplit) {
                const halfAmount = amount / 2;
                const daniAccount = config.ACTUAL_DEFAULT_ACCOUNT_DANI;

                await ActualMgr.addTransaction('rene', {
                    accountName, categoryName, payeeName: tx.payee || null, amount: halfAmount, date, notes,
                });

                if (config.ACTUAL_SYNC_ID_2) {
                    await ActualMgr.addTransaction('dani', {
                        accountName: daniAccount, categoryName, payeeName: tx.payee || null, amount: halfAmount, date, notes,
                    });
                }

                // Balance: positive = Dani owes René, negative = René owes Dani
                const balanceDelta = userId === config.ACTUAL_USER_RENE ? halfAmount : -halfAmount;
                await ActualMgr.updateBalance(balanceDelta, config.ACTUAL_BALANCE_ACCOUNT);

                if (config.BOT_VERBOSITY >= VERBOSITY.NORMAL) {
                    replyMessage += '```\n' + helpers.prettyjson({
                        fecha: date,
                        cuenta_rene: accountName,
                        cuenta_dani: daniAccount,
                        categoría: categoryName,
                        monto_cada_uno: halfAmount.toFixed(2) + ' ' + config.ACTUAL_CURRENCY,
                        ...(tx.payee && { payee: tx.payee }),
                    }) + '```\n';
                }
                added++;
            } else {
                await ActualMgr.addTransaction(budgetKey, {
                    accountName, categoryName, payeeName: tx.payee || null, amount, date, notes,
                });

                if (config.BOT_VERBOSITY >= VERBOSITY.NORMAL) {
                    replyMessage += '```\n' + helpers.prettyjson({
                        fecha: date,
                        cuenta: accountName,
                        categoría: categoryName,
                        monto: amount + ' ' + config.ACTUAL_CURRENCY,
                        ...(tx.payee && { payee: tx.payee }),
                        ...(tx.notes && { notas: tx.notes }),
                    }) + '```\n';
                }
                added++;
            }
        }

        replyMessage += '\n*[ACTUAL]*\n';
        replyMessage += added ? 'agregadas: ' + added : 'sin cambios';

        if (isSplit && added) {
            try {
                const balance = await ActualMgr.getBalance(config.ACTUAL_BALANCE_ACCOUNT);
                replyMessage += '\n\n💰 *Balance actualizado:*\n' + formatBalance(balance);

                const otherId = userId === config.ACTUAL_USER_RENE ? config.ACTUAL_USER_DANI : config.ACTUAL_USER_RENE;
                if (otherId) {
                    const otherMsg = '📌 *Gasto compartido registrado por ' + userName + '*\n' + replyMessage;
                    try { await Bot.telegram.sendMessage(otherId, otherMsg, { parse_mode: 'Markdown' }); }
                    catch (e) { logger.warn('No se pudo notificar al otro usuario: ' + e.message); }
                }
            } catch (e) {
                logger.warn('No se pudo obtener balance actualizado: ' + e.message);
            }
        }

        logger.info(added + ' transacción(es) agregada(s) a Actual Budget.');

        if (config.BOT_VERBOSITY > VERBOSITY.SILENT) {
            return ctx.reply(replyMessage, {
                parse_mode: 'Markdown',
                ...(userName !== INPUT_API_USER && { reply_to_message_id: ctx.message.message_id })
            });
        }

    } catch (err) {
        logger.error('Error al crear transacciones en Actual Budget:', err);
        if (err.message && err.message.includes('convertir la moneda')) {
            return ctx.reply('Hubo un error al convertir la moneda. Revisa los logs.',
                userName === INPUT_API_USER ? {} : { reply_to_message_id: ctx.message.message_id });
        }
        return ctx.reply('Hubo un error al guardar la(s) transacción(es). Revisa los logs.',
            userName === INPUT_API_USER ? {} : { reply_to_message_id: ctx.message.message_id });
    }
});

// Webhook endpoint
App.post('/webhook', (req, res) => {
    try {
        Bot.handleUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        logger.error('Error al manejar actualización:', error);
        res.sendStatus(500);
    }
});

// Custom input endpoint
App.post('/input', (req, res) => {
    try {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey || apiKey !== config.INPUT_API_KEY || !config.INPUT_API_KEY || config.INPUT_API_KEY.length < 16) {
            return res.status(401).send('Unauthorized');
        }
        const { user_id, text } = req.body;
        if (config.USER_IDS.includes(user_id)) {
            Bot.handleUpdate(helpers.createUpdateObject(user_id, INPUT_API_USER, text));
            return res.json({ status: 'OK' });
        } else {
            return res.status(403).send('Forbidden');
        }
    } catch (error) {
        logger.error('Error al manejar input personalizado. ', error);
        return res.status(500).json({ error: 'Error al procesar el mensaje' });
    }
});

// Health check
App.get('/health', (req, res) => res.send('OK'));
