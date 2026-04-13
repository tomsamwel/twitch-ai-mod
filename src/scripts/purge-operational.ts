import { loadConfig } from "../config/load-config.js";
import { BotDatabase } from "../storage/database.js";

const config = await loadConfig(process.cwd());
const database = new BotDatabase(config.storage.sqlitePath);
const result = database.purgeOperationalData();
database.close();
console.log(
  `Purged: ${result.messages} messages, ${result.decisions} decisions, ${result.actions} actions, ${result.events} events, ${result.reviews} reviews, ${result.greetedUsers} greeted users`,
);
