// src/simulator/positions.js

const express = require("express");

const data = require("./data");
const { authenticate } = require("./auth");

const router = express.Router();

/**
 * GET /api/position/get_page?login=100001
 *
 * Returns MT5-compatible open positions.
 */
router.get("/position/get_page", authenticate, (req, res) => {

    const login = Number(req.query.login);

    const user = data.users.get(login);

    if (!user) {
        return res.status(404).json({
            retcode: "10001 Invalid request"
        });
    }

    const positions = [];

    for (const position of data.positions.values()) {

        if (position.Login === login) {
            positions.push(position);
        }

    }

    return res.json({
        retcode: "0 Done",
        answer: positions
    });

});

/**
 * POST /api/position/open
 *
 * Simulator only.
 * This endpoint DOES NOT exist in MT5.
 * It lets us create positions for testing.
 */
router.post("/position/open", authenticate, (req, res) => {

    const login = Number(req.body.Login);

    const user = data.users.get(login);

    if (!user) {
        return res.status(404).json({
            retcode: "10001 Invalid request"
        });
    }

    const positionId = data.nextPosition();

    const now = Math.floor(Date.now() / 1000);

    const position = {

        Position: positionId,

        ExternalID: "",

        Login: login,

        Dealer: 0,

        Symbol: req.body.Symbol,

        Action: req.body.Action || 0,

        Digits: req.body.Digits || 5,

        Volume: req.body.Volume,

        PriceOpen: req.body.PriceOpen,

        PriceCurrent: req.body.PriceOpen,

        PriceSL: req.body.PriceSL || 0,

        PriceTP: req.body.PriceTP || 0,

        Profit: 0,

        Storage: 0,

        Commission: 0,

        TimeCreate: now,

        TimeUpdate: now

    };

    data.positions.set(positionId, position);

    return res.json({
        retcode: "0 Done",
        answer: {
            Position: positionId
        }
    });

});

/**
 * POST /api/position/close
 *
 * Simulator only.
 */
router.post("/position/close", authenticate, (req, res) => {

    const positionId = Number(req.body.Position);

    const position = data.positions.get(positionId);

    if (!position) {
        return res.status(404).json({
            retcode: "10001 Invalid request"
        });
    }

    data.positions.delete(positionId);

    return res.json({
        retcode: "0 Done"
    });

});

module.exports = router;