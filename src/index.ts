import { loadConfig } from './config.js';
import { createHandler } from './handler.js';
import { createLlm } from './llm.js';
import { createMessenger } from './messenger.js';
import { createWebhookServer } from './server.js';

const config = loadConfig();
const messenger = createMessenger(config.messengerUrl, config.botToken);
const llm = createLlm(config);
const handler = createHandler({ config, messenger, llm });

createWebhookServer(config, handler).listen(config.port, () => {
  console.log(`[reminder-bot] webhook listener on :${config.port}`);
  console.log(`[reminder-bot] messenger: ${config.messengerUrl}`);
  console.log(`[reminder-bot] llm:       ${config.llmBaseUrl} (${config.llmModel})`);
  console.log(`[reminder-bot] timezone:  ${config.userTimezone}`);
  console.log(
    `[reminder-bot] NOTE: the bot's webhookUrl must be reachable FROM the messenger server/container — "localhost" inside its container is not this bot. Use a shared docker network name or a host address.`,
  );
});
