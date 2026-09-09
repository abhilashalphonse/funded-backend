class DataStore {
    constructor() {
        this.sessions = new Map();
        this.users = new Map();
        this.positions = new Map();
        this.orders = new Map();
        this.deals = new Map();

        this.counters = {
            login: 100000,
            ticket: 5500000,
            position: 6600000,
            order: 7700000,
            deal: 8800000
        };
    }

    nextLogin() {
        return ++this.counters.login;
    }

    nextTicket() {
        return ++this.counters.ticket;
    }

    nextPosition() {
        return ++this.counters.position;
    }

    nextOrder() {
        return ++this.counters.order;
    }

    nextDeal() {
        return ++this.counters.deal;
    }
}

module.exports = new DataStore();