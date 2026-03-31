/**
 * ActualManager - Optimized multi-budget manager for @actual-app/api
 * 
 * Since @actual-app/api is a singleton, we can't have two open budgets
 * simultaneously. This manager handles switching between budgets efficiently
 * using a sequential operation queue with smart caching.
 * 
 * Key optimizations:
 * - Stays connected to the last-used budget (avoids unnecessary reconnects)
 * - Queues concurrent operations so they run sequentially without collisions
 * - Caches accounts/categories per budget to avoid redundant API calls
 * - Lazy initialization (connects on first use, not at startup)
 */

const Actual = require('@actual-app/api');
const fs = require('fs');

class ActualManager {
    constructor(config) {
        this.config = config; // { serverURL, password, budgets: { rene: { syncId, dataDir }, dani: { syncId, dataDir } } }
        this.currentBudget = null;
        this.cache = {}; // { budgetKey: { accounts, categories, payees } }
        this.queue = Promise.resolve(); // Sequential operation queue
        this.initialized = false;
    }

    /**
     * Enqueue an operation - ensures all operations run sequentially
     * This is the core of thread-safety in Node.js async context
     */
    enqueue(fn) {
        this.queue = this.queue.then(fn).catch(err => {
            // Reset state on error so next operation starts fresh
            this.currentBudget = null;
            throw err;
        });
        return this.queue;
    }

    /**
     * Switch to a budget if not already active
     * Only reconnects when necessary (smart caching of active connection)
     */
    async _switchToBudget(budgetKey) {
        if (this.currentBudget === budgetKey) {
            return; // Already connected, skip reconnect
        }

        const budget = this.config.budgets[budgetKey];
        if (!budget) throw new Error(`Unknown budget: ${budgetKey}`);

        // Shutdown current connection if any
        if (this.currentBudget !== null) {
            await Actual.shutdown();
        }

        // Ensure data directory exists
        if (!fs.existsSync(budget.dataDir)) {
            fs.mkdirSync(budget.dataDir, { recursive: true });
        }

        // Init and download budget
        await Actual.init({
            dataDir: budget.dataDir,
            serverURL: this.config.serverURL,
            password: this.config.password,
        });

        await Actual.downloadBudget(budget.syncId);
        this.currentBudget = budgetKey;

        // Invalidate cache for this budget (fresh data after reconnect)
        delete this.cache[budgetKey];
    }

    /**
     * Get cached or fresh accounts/categories/payees for a budget
     */
    async _getCache(budgetKey) {
        if (!this.cache[budgetKey]) {
            const [accounts, categories, payees] = await Promise.all([
                Actual.getAccounts(),
                Actual.getCategories(),
                Actual.getPayees(),
            ]);
            this.cache[budgetKey] = { accounts, categories, payees };
        }
        return this.cache[budgetKey];
    }

    /**
     * Run an operation on a specific budget
     * Handles switching and caching automatically
     */
    async runOnBudget(budgetKey, fn) {
        return this.enqueue(async () => {
            await this._switchToBudget(budgetKey);
            const cache = await this._getCache(budgetKey);
            return fn(Actual, cache);
        });
    }

    /**
     * Add a transaction to a specific budget
     */
    async addTransaction(budgetKey, { accountName, categoryName, payeeName, amount, date, notes }) {
        return this.runOnBudget(budgetKey, async (actual, cache) => {
            const account = cache.accounts.find(a => a.name === accountName);
            const category = cache.categories.find(c => c.name === categoryName);

            if (!account) throw new Error(`Invalid account: "${accountName}"`);
            if (!category) throw new Error(`Invalid category: "${categoryName}"`);

            const payee = cache.payees.find(p => p.name === payeeName);

            const tx = {
                account: account.id,
                date: date || new Date().toISOString().split('T')[0],
                amount: Math.round(amount * 100), // Convert to cents
                category: category.id,
                payee_name: payeeName || null,
                notes: notes || '',
            };

            await actual.addTransactions(account.id, [tx]);
            await actual.sync();

            // Invalidate payee cache since we may have added a new one
            if (!payee && payeeName) {
                delete this.cache[budgetKey];
            }

            return tx;
        });
    }

    /**
     * Add a split transaction to BOTH budgets sequentially
     * Returns both transaction results
     */
    async addSplitTransaction(budgetKeyA, budgetKeyB, txData) {
        const halfAmount = txData.amount / 2;

        // Run both operations in sequence via the queue
        const txA = await this.addTransaction(budgetKeyA, { ...txData, amount: halfAmount });
        const txB = await this.addTransaction(budgetKeyB, { ...txData, amount: halfAmount });

        return { txA, txB };
    }

    /**
     * Update the shared balance account
     * Positive = Dani owes René, Negative = René owes Dani
     */
    async updateBalance(delta, balanceAccountName) {
        return this.runOnBudget('rene', async (actual, cache) => {
            const balanceAccount = cache.accounts.find(a => a.name === balanceAccountName);
            if (!balanceAccount) throw new Error(`Balance account not found: "${balanceAccountName}"`);

            const tx = {
                account: balanceAccount.id,
                date: new Date().toISOString().split('T')[0],
                amount: Math.round(delta * 100),
                notes: '🤖 Balance update',
            };

            await actual.addTransactions(balanceAccount.id, [tx]);
            await actual.sync();
            return tx;
        });
    }

    /**
     * Get current balance (sum of all transactions in balance account)
     */
    async getBalance(balanceAccountName) {
        return this.runOnBudget('rene', async (actual, cache) => {
            const balanceAccount = cache.accounts.find(a => a.name === balanceAccountName);
            if (!balanceAccount) throw new Error(`Balance account not found: "${balanceAccountName}"`);

            const transactions = await actual.getTransactions(balanceAccount.id);
            const total = transactions.reduce((sum, tx) => sum + tx.amount, 0);
            return total / 100; // Convert from cents
        });
    }

    /**
     * Reset balance to zero by adding a clearing transaction
     */
    async resetBalance(balanceAccountName) {
        const current = await this.getBalance(balanceAccountName);
        if (current === 0) return 0;
        await this.updateBalance(-current, balanceAccountName);
        return current;
    }

    /**
     * Get accounts/categories for a budget (for LLM prompt building)
     */
    async getBudgetData(budgetKey) {
        return this.runOnBudget(budgetKey, async (actual, cache) => {
            return {
                accounts: cache.accounts,
                categories: cache.categories,
                payees: cache.payees,
            };
        });
    }
}

module.exports = ActualManager;
