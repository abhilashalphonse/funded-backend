// src/simulator/trades.js

const express = require("express");

const data = require("./data");
const { authenticate } = require("./auth");

const router = express.Router();

/**
 * POST /api/trade/balance
 *
 * Body:
 * {
 *   "Login":100001,
 *   "Type":"DEPOSIT", // DEPOSIT | WITHDRAW
 *   "Amount":100000,
 *   "Comment":"Initial Challenge Balance"
 * }
 *
 * MT5 Response:
 * {
 *   "retcode":"0 Done",
 *   "answer":{
 *      "Ticket":5500001
 *   }
 * }
 */
router.post("/trade/balance", authenticate, (req, res) => {

    const login = Number(req.body.Login);

    const amount = Number(req.body.Amount || 0);

    const type = (req.body.Type || "DEPOSIT").toUpperCase();

    const user = data.users.get(login);

    if (!user) {
        return res.status(404).json({
            retcode: "10001 Invalid request"
        });
    }

    const ticket = data.nextTicket();

    if (type === "DEPOSIT") {
        user.Balance += amount;
    } else if (type === "WITHDRAW") {
        user.Balance -= amount;
    } else {
        return res.status(400).json({
            retcode: "10001 Invalid request"
        });
    }

    // No open positions yet
    user.Equity = user.Balance + user.Credit;
    user.Margin = 0.00;
    user.MarginFree = user.Equity;
    user.MarginLevel = 0.00;

    data.users.set(login, user);

    data.deals.set(ticket, {
        Ticket: ticket,
        Login: login,
        Type: type,
        Amount: amount,
        Comment: req.body.Comment || "",
        Time: Math.floor(Date.now() / 1000)
    });

    return res.json({
        retcode: "0 Done",
        answer: {
            Ticket: ticket
        }
    });

});

module.exports = router;