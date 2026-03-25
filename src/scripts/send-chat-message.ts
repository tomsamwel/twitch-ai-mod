import { createAppServices } from "../bootstrap.js";

async function main(): Promise<void> {
  const message = process.argv.slice(2).join(" ").trim();

  if (!message) {
    throw new Error("Provide a message: npm run chat:send -- \"hello world\"");
  }

  const services = await createAppServices();

  try {
    const action = services.actionExecutor.createActionRequest(
      {
        kind: "say",
        reason: "manual verification message",
        message,
      },
      {
        source: "ai",
        sourceEventId: "manual-send",
        sourceMessageId: "manual-send",
      },
    );

    const result = await services.actionExecutor.execute(action);
    services.logger.info({ result }, "manual send script finished");
  } finally {
    await services.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
