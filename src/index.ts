import { createApp } from "./app.js";

const app = createApp();
const port = process.env.PORT ?? 3000;
const host = process.env.HOST ?? "0.0.0.0";

app.listen(port, () => {
  console.log(`Gateway API listening on ${host}:${port}`);
});
