import express from "express";
import tradeWebhookRoutes from "./apis/routes/tradeWebhook.routes.js";

const app = express();

app.use(express.json());

app.use(
    "/api",
    tradeWebhookRoutes
);

app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "MT5 MVP API is running",
  });
});

// POST endpoint
app.post("/api/users", (req, res) => {
    const { name, age } = req.body;

    // Validate input
    if (!name || age === undefined) {
        return res.status(400).json({
            success: false,
            message: "Name and age are required."
        });
    }

    // Simulate saving to database
    const user = {
        id: Date.now(),
        name,
        age
    };

    // Return response
    res.status(201).json({
        success: true,
        message: "User created successfully.",
        data: user
    });
})

export default app;