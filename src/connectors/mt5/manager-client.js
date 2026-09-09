const EventEmitter = require('events');

class MT5ManagerClient extends EventEmitter {
    constructor(config = {}) {
        super();

        this.config = {
            server: config.server,
            port: config.port || 443,
            login: config.login,
            password: config.password,
            timeout: config.timeout || 30000
        };

        this.connected = false;
        this.bridge = null; // Future MT5 bridge
    }

    async connect() {
        try {
            /**
             * Future:
             *
             * this.bridge = new MT5Bridge(...)
             * await this.bridge.connect(...)
             */

            this.connected = true;

            this.emit('connected');

            return true;
        } catch (err) {
            this.emit('error', err);
            throw err;
        }
    }

    async disconnect() {
        if (!this.connected) return;

        /**
         * Future:
         * await this.bridge.disconnect();
         */

        this.connected = false;

        this.emit('disconnected');
    }

    isConnected() {
        return this.connected;
    }

    /*
     * USERS
     */

    async getUsers() {
        // Future:
        // return this.bridge.users();

        return [];
    }

    async getUser(login) {
        // return this.bridge.user(login);

        return null;
    }

    async createUser(user) {
        // return this.bridge.userAdd(user);

        return true;
    }

    async updateUser(login, updates) {
        // return this.bridge.userUpdate(login, updates);

        return true;
    }

    async deleteUser(login) {
        // return this.bridge.userDelete(login);

        return true;
    }

    /*
     * POSITIONS
     */

    async getPositions(login = null) {
        return [];
    }

    async getPosition(ticket) {
        return null;
    }

    /*
     * ORDERS
     */

    async getOrders(login = null) {
        return [];
    }

    /*
     * DEALS
     */

    async getDeals(login = null) {
        return [];
    }

    /*
     * GROUPS
     */

    async getGroups() {
        return [];
    }

    /*
     * ACCOUNT
     */

    async getAccount(login) {
        return null;
    }

    /*
     * COMMANDS
     */

    async closePosition(ticket) {
        return true;
    }

    async closeAllPositions(login) {
        return true;
    }

    async enableTrading(login) {
        return true;
    }

    async disableTrading(login) {
        return true;
    }

    async moveGroup(login, group) {
        return true;
    }

    async updateLeverage(login, leverage) {
        return true;
    }

    /*
     * HEALTH
     */

    async ping() {
        return {
            connected: this.connected,
            timestamp: new Date()
        };
    }
}

module.exports = MT5ManagerClient;