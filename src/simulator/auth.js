// src/simulator/auth.js

const crypto = require("crypto");
const express = require("express");

const data = require("./data");

const router = express.Router();

/**
 * GET /api/auth/start
 *
 * MT5 Web API:
 * Returns a server random string used during authentication.
 */
router.get("/auth/start", (req, res) => {
    const srvRand = crypto.randomBytes(16).toString("hex").toUpperCase();

    data.sessions.set(srvRand, {
        srvRand,
        createdAt: Date.now()
    });

    return res.json({
        retcode: "0 Done",
        answer: {
            srv_rand: srvRand,
            srv_rand_answer: crypto
                .createHash("md5")
                .update(srvRand)
                .digest("hex")
                .toUpperCase()
        }
    });
});

/**
 * POST /api/auth/answer
 *
 * Body:
 * {
 *   "srv_rand":"...",
 *   "cli_rand_answer":"..."
 * }
 *
 * For the simulator we don't validate the hash.
 * We simply issue an auth token exactly like MT5.
 */
router.post("/auth/answer", (req, res) => {

    const { srv_rand, cli_rand_answer } = req.body;

    const session = data.sessions.get(srv_rand);

    if (!session) {
        return res.status(401).json({
            retcode: "0130 Auth failed"
        });
    }

    const auth = crypto.randomBytes(20).toString("hex").toUpperCase();

    session.auth = auth;
    session.cli_rand_answer = cli_rand_answer;
    session.authenticated = true;

    data.sessions.set(srv_rand, session);

    return res.json({
        retcode: "0 Done",
        answer: {
            cli_rand_answer,
            auth
        }
    });

});

/**
 * Middleware
 *
 * Protects every endpoint except auth.
 */
function authenticate(req, res, next) {

    const token = req.headers.authorization;

    if (!token) {
        return res.status(401).json({
            retcode: "0130 Auth failed"
        });
    }

    const session = [...data.sessions.values()].find(
        s => s.auth === token
    );

    if (!session) {
        return res.status(401).json({
            retcode: "0130 Auth failed"
        });
    }

    req.session = session;

    next();
}

module.exports = {
    router,
    authenticate
};