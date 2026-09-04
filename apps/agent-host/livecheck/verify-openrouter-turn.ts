// Live OpenRouter verification for issue #21 (NOT part of the committed
// test suite — the suite stays hermetic. Run on demand; see PR body).
//
// Usage: OPENROUTER_API_KEY=sk-or-... bun apps/agent-host/livecheck/verify-openrouter-turn.ts
//
// Builds the REAL HarnessTurnStarter (llm-deepseek adapter against
// LLM_BASE_URL), starts one turn in a temp workspace, and prints the
// persisted event types + assistant reply markers (the key is never printed).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@cloud-run-dsh/observability";
import {
  PostgresSessionPersistenceRepository,
} from "@cloud-run-dsh/session-persistence-postgres";
import { InMemoryFakeExecutor } from "@cloud-run-dsh/session-persistence-postgres/testing";
import { makeConfig } from "../src/fakes.js";
import { HarnessTurnStarter } from "../src/turn.js";

const key = process.env["OPENROUTER_API_KEY"];
if (!key) {
  console.error("OPENROUTER_API_KEY is not set");
  process.exit(2);
}

const workspaceRoot = await mkdtemp(join(tmpdir(), "live-turn-"));
const repository = new PostgresSessionPersistenceRepository(new InMemoryFakeExecutor());
const config = makeConfig({ workspaceRoot });
await repository.createWorkspace({
  id: config.workspaceId,
  ownerId: config.userId,
  repositoryOwner: config.repositoryOwner,
  repositoryName: config.repositoryName,
  baseBranch: config.baseBranch,
});
const sessionId = "sess-live-1";
await repository.createSession({ id: sessionId, workspaceId: config.workspaceId });
await repository.append(sessionId, [
  {
    eventType: "user_message",
    eventTime: Date.now(),
    data: { content: "Say the word BANANA and nothing else." },
  },
]);

const logger = createLogger({ defaultFields: { component: "verify-live" } });
const starter = await HarnessTurnStarter.create({ config, repository, logger });
await starter.startTurn({
  workspaceId: config.workspaceId,
  sessionId,
  seq: 0,
  content: "Say the word BANANA and nothing else.",
});

const deadline = Date.now() + 120_000;
for (;;) {
  const events = await repository.readEvents(sessionId);
  const reply = events.find((e) => e.eventType === "assistant/message");
  const failed = events.find((e) => e.eventType === "assistant/error" || e.eventType === "turn/error");
  if (reply || failed) {
    console.log("EVENT_TYPES=" + JSON.stringify(events.map((e) => e.eventType)));
    if (reply) {
      const text = JSON.stringify(reply.data);
      console.log("ASSISTANT_CHARS=" + text.length);
      console.log("ASSISTANT_HAS_BANANA=" + text.includes("BANANA"));
    }
    if (failed) {
      console.log("FAILURE=" + JSON.stringify(failed.data).slice(0, 500));
    }
    console.log(
      "USER_MESSAGE_ROWS=" + events.filter((e) => e.eventType === "user_message").length,
    );
    break;
  }
  if (Date.now() > deadline) {
    console.log("EVENT_TYPES_SO_FAR=" + JSON.stringify(events.map((e) => e.eventType)));
    console.error("LIVE_TURN_TIMEOUT");
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
process.exit(0);
