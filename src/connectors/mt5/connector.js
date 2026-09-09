const EventEmitter = require("events");

const ManagerClient = require("./manager-client");
const Mapper = require("./mapper");

class MT5Connector extends EventEmitter {

    constructor(config = {}) {

        super();

        this.client = new ManagerClient(config);

        this.interval = config.pollInterval || 1000;

        this.timer = null;

    }

    async connect() {

        await this.client.connect();

        this.emit("connected");

    }

    async disconnect() {

        this.stop();

        await this.client.disconnect();

        this.emit("disconnected");

    }

    async start() {

        if (this.timer) return;

        await this.poll();

        this.timer = setInterval(() => {

            this.poll();

        }, this.interval);

    }

    stop() {

        if (!this.timer) return;

        clearInterval(this.timer);

        this.timer = null;

    }

    async poll() {

        try {

            const users = await this.client.getUsers();

            for (const user of users) {

                const event = Mapper.account(user);

                this.emit("event", event);

            }

            const positions = await this.client.getPositions();

            for (const position of positions) {

                const event = Mapper.position(position);

                this.emit("event", event);

            }

            const orders = await this.client.getOrders();

            for (const order of orders) {

                const event = Mapper.order(order);

                this.emit("event", event);

            }

            const deals = await this.client.getDeals();

            for (const deal of deals) {

                const event = Mapper.deal(deal);

                this.emit("event", event);

            }

        } catch (err) {

            this.emit("error", err);

        }

    }

    async execute(command) {

        switch (command.type) {

            case "CLOSE_POSITION":

                return this.client.closePosition(command.ticket);

            case "CLOSE_ALL_POSITIONS":

                return this.client.closeAllPositions(command.accountId);

            case "ENABLE_TRADING":

                return this.client.enableTrading(command.accountId);

            case "DISABLE_TRADING":

                return this.client.disableTrading(command.accountId);

            case "MOVE_GROUP":

                return this.client.moveGroup(
                    command.accountId,
                    command.group
                );

            case "UPDATE_LEVERAGE":

                return this.client.updateLeverage(
                    command.accountId,
                    command.leverage
                );

            default:

                throw new Error(`Unsupported command: ${command.type}`);

        }

    }

}

module.exports = MT5Connector; 