import express from "express";
import { plansToProjectRouter } from "./routes/plans-to-project.js";

const app = express();
const port = process.env.PORT ?? 3000;
const host = process.env.HOST ?? "0.0.0.0";

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/plans-to-project", plansToProjectRouter);

app.listen(port, () => {
  console.log(`Gateway API listening on ${host}:${port}`);
});
