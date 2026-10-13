import { describe, expect, it } from "vitest";
import {
  engagementDecisionSchema,
  parseDecisionJson,
  stayDecisionSchema,
} from "../src/conversation/decision-schema.js";

const engagementDecision = {
  engage: true,
  confidence: 0.8,
  reason: "a question for the bot",
  targetMessageIds: ["m1"],
  expectedRole: "answer_question",
};

const stayDecision = {
  stayEngaged: true,
  action: "react",
  confidence: 0.9,
  reason: "acknowledge the reply",
  attention: "directed_at_bot",
  targetMessageIds: ["m1"],
  replyPriority: "none",
};

describe("decision JSON validation", () => {
  it.each(["plain", "json fence", "bare fence"])("accepts %s JSON from the agent", (format) => {
    const json = JSON.stringify(engagementDecision);
    const text =
      format === "plain" ? json : `\`\`\`${format === "json fence" ? "json" : ""}\n${json}\n\`\`\``;

    expect(engagementDecisionSchema.parse(parseDecisionJson(`\n ${text} \n`))).toEqual(engagementDecision);
  });

  it.each([-0.1, 1.1, "0.9"])("rejects confidence outside the contract: %s", (confidence) => {
    const value = parseDecisionJson(JSON.stringify({ ...engagementDecision, confidence }));

    expect(() => engagementDecisionSchema.parse(value)).toThrow();
    expect(() => stayDecisionSchema.parse({ ...stayDecision, confidence })).toThrow();
  });

  it("rejects malformed JSON and explanatory text surrounding JSON", () => {
    expect(() => parseDecisionJson('{"engage":')).toThrow(SyntaxError);
    expect(() => parseDecisionJson(`Here is my decision: ${JSON.stringify(engagementDecision)}`)).toThrow(
      SyntaxError,
    );
  });

  it("rejects missing or invalid engagement fields", () => {
    expect(() => engagementDecisionSchema.parse({ ...engagementDecision, engage: "true" })).toThrow();
    expect(() => engagementDecisionSchema.parse({ ...engagementDecision, expectedRole: "reply" })).toThrow();
    expect(() => engagementDecisionSchema.parse({ ...engagementDecision, targetMessageIds: [1] })).toThrow();
    expect(() => engagementDecisionSchema.parse({ engage: true })).toThrow();
  });

  it("keeps stay hints optional and validates supplied hints", () => {
    const value = parseDecisionJson(JSON.stringify(stayDecision));
    expect(stayDecisionSchema.parse(value)).toEqual(stayDecision);
    expect(stayDecisionSchema.parse({ ...stayDecision, reactionHint: "ack" })).toEqual({
      ...stayDecision,
      reactionHint: "ack",
    });
    expect(() => stayDecisionSchema.parse({ ...stayDecision, reactionHint: "invalid" })).toThrow();
    expect(() => stayDecisionSchema.parse({ ...stayDecision, disengageReason: "invalid" })).toThrow();
  });

  it("rejects invalid stay action, attention, and reply priority", () => {
    expect(() => stayDecisionSchema.parse({ ...stayDecision, action: "send" })).toThrow();
    expect(() => stayDecisionSchema.parse({ ...stayDecision, attention: "unknown" })).toThrow();
    expect(() => stayDecisionSchema.parse({ ...stayDecision, replyPriority: "high" })).toThrow();
  });
});
