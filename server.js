import { createApp } from "./src/server/create-app.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = "127.0.0.1";
const app = createApp();

app.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`Backup Explorer listening on http://${HOST}:${PORT}`);
});
