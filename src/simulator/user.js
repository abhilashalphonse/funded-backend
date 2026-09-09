// src/simulator/users.js

const express = require("express");

const data = require("./data");
const { authenticate } = require("./auth");

const router = express.Router();

/**
 * POST /api/user/add
 *
 * Body:
 * {
 *   "Group":"demo\\prop_phase1_100k",
 *   "Name":"John Doe",
 *   "Email":"john@example.com",
 *   "Country":"US",
 *   "City":"New York",
 *   "Phone":"+123456789",
 *   "Leverage":100
 * }
 */
router.post("/user/add", authenticate, (req, res) => {

    const login = data.nextLogin();

    const user = {
        Login: login,

        Group: req.body.Group || "demo\\default",

        Name: req.body.Name || "",

        Company: req.body.Company || "Your Prop Firm",

        Email: req.body.Email || "",

        Country: req.body.Country || "",

        City: req.body.City || "",

        Phone: req.body.Phone || "",

        Leverage: req.body.Leverage || 100,

        Balance: 0.00,

        Credit: 0.00,

        Margin: 0.00,

        MarginFree: 0.00,

        MarginLevel: 0.00,

        Equity: 0.00,

        LeadSource: req.body.LeadSource || "Dashboard",

        Enable: 1
    };

    data.users.set(login, user);

    return res.json({
        retcode: "0 Done",
        answer: {
            Login: login
        }
    });

});

/**
 * GET /api/user/get?login=100001
 */
router.get("/user/get", authenticate, (req, res) => {

    const login = Number(req.query.login);

    const user = data.users.get(login);

    if (!user) {
        return res.status(404).json({
            retcode: "10001 Invalid request"
        });
    }

    return res.json({
        retcode: "0 Done",
        answer: user
    });

});

/**
 * POST /api/user/update
 *
 * Body:
 * {
 *   "Login":100001,
 *   "Enable":0
 * }
 */
router.post("/user/update", authenticate, (req, res) => {

    const login = Number(req.body.Login);

    const user = data.users.get(login);

    if (!user) {
        return res.status(404).json({
            retcode: "10001 Invalid request"
        });
    }

    Object.keys(req.body).forEach(key => {

        if (key === "Login") return;

        user[key] = req.body[key];

    });

    data.users.set(login, user);

    return res.json({
        retcode: "0 Done"
    });

});

module.exports = router;