import { describe, expect, it } from "vitest";
import { isDirectedAtBot } from "../src/conversation/reply-cadence.js";
import { createBotIdentity } from "../src/discord/bot-identity.js";
import { createMessage } from "./helpers/conversation.js";

const user = { id: "bot-1", username: "chatter", globalName: "채터", tag: "chatter#0001" };

describe("bot identity", () => {
  it("uses only actual Discord names as aliases", () => {
    expect(createBotIdentity(user)).toEqual({
      userId: user.id,
      username: user.username,
      globalName: user.globalName,
      tag: user.tag,
      mention: "<@bot-1>",
      names: ["chatter", "채터", "chatter#0001"],
    });
  });

  it("trims, deduplicates, and excludes missing or blank names", () => {
    expect(createBotIdentity({ ...user, globalName: null, tag: " chatter " }).names).toEqual(["chatter"]);
    expect(createBotIdentity({ ...user, globalName: "  ", tag: "chatter" }).names).toEqual(["chatter"]);
  });

  it.each(["다른 bot 상태 확인해 줘", "BOT 도와줘", "robot 이야기", "chatbot 모델 비교"])(
    "does not treat %s as a call to chatter",
    (cleanContent) => {
      const identity = createBotIdentity(user);
      expect(isDirectedAtBot(createMessage("m1", { cleanContent }), identity.userId, identity.names)).toBe(
        false,
      );
    },
  );

  it.each(["chatter 도와줘", "CHATTER!", "채터야", "chatter#0001 안녕"])(
    "preserves real name calls: %s",
    (cleanContent) => {
      const identity = createBotIdentity(user);
      expect(isDirectedAtBot(createMessage("m1", { cleanContent }), identity.userId, identity.names)).toBe(
        true,
      );
    },
  );

  it("preserves bot when it really is a Discord name", () => {
    const identity = createBotIdentity({ ...user, username: "bot", globalName: null, tag: "bot" });
    expect(
      isDirectedAtBot(createMessage("m1", { cleanContent: "bot 안녕" }), identity.userId, identity.names),
    ).toBe(true);
  });
});
