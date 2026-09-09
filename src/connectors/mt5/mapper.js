class MT5Mapper {

    /**
     * Account
     */
    static account(account) {

        return {
            type: "ACCOUNT_UPDATED",

            accountId: account.Login,

            timestamp: new Date(),

            payload: {
                login: account.Login,
                name: account.Name,
                group: account.Group,

                balance: account.Balance,
                equity: account.Equity,
                margin: account.Margin,
                marginFree: account.MarginFree,
                marginLevel: account.MarginLevel,

                leverage: account.Leverage,

                credit: account.Credit,

                enabled: account.Enable,

                raw: account
            }
        };

    }

    /**
     * Position
     */

    static position(position) {

        return {
            type: "POSITION_UPDATED",

            accountId: position.Login,

            timestamp: new Date(),

            payload: {

                ticket: position.Ticket,

                symbol: position.Symbol,

                volume: position.Volume,

                type: position.Type,

                priceOpen: position.PriceOpen,

                priceCurrent: position.PriceCurrent,

                profit: position.Profit,

                swap: position.Swap,

                commission: position.Commission,

                sl: position.SL,

                tp: position.TP,

                raw: position

            }

        };

    }

    /**
     * Order
     */

    static order(order) {

        return {

            type: "ORDER_UPDATED",

            accountId: order.Login,

            timestamp: new Date(),

            payload: {

                ticket: order.Ticket,

                symbol: order.Symbol,

                volume: order.Volume,

                type: order.Type,

                price: order.Price,

                sl: order.SL,

                tp: order.TP,

                raw: order

            }

        };

    }

    /**
     * Deal
     */

    static deal(deal) {

        return {

            type: "DEAL_ADDED",

            accountId: deal.Login,

            timestamp: new Date(),

            payload: {

                ticket: deal.Ticket,

                dealId: deal.Deal,

                order: deal.Order,

                symbol: deal.Symbol,

                volume: deal.Volume,

                price: deal.Price,

                profit: deal.Profit,

                commission: deal.Commission,

                swap: deal.Swap,

                raw: deal

            }

        };

    }

}

module.exports = MT5Mapper;