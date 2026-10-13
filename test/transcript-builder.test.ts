import { describe, expect, it } from "vitest";
import { buildTranscript } from "../src/conversation/transcript-builder.js";
import type { NormalizedDiscordEvent } from "../src/types.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";

describe("transcript builder", () => {
  it("keeps reply, attachment, embed, reaction, edit, and delete data inside message blocks", () => {
    const events: NormalizedDiscordEvent[] = [
      createMessageEvent(message("m1", "u1", "neuw", "hello")),
      createMessageEvent({
        ...message("m2", "u2", "min", "see file"),
        replyTo: {
          messageId: "m1",
          authorId: "u1",
          authorDisplayName: "neuw",
          contentPreview: "hello",
          attachments: [
            {
              id: "ra1",
              url: "https://cdn.example/r.png",
              filename: "r.png",
              mimeType: "image/png",
              size: 2,
              kind: "image",
            },
          ],
          embeds: [{ title: "reply-embed", description: "reply-desc" }],
        },
        attachments: [
          {
            id: "a1",
            url: "https://cdn.example/a.png",
            filename: "a.png",
            mimeType: "image/png",
            size: 1,
            kind: "image",
          },
        ],
        embeds: [{ title: "title", description: "desc", url: "https://example.com" }],
        reactions: [{ emoji: "👍", count: 1, me: false }],
        editedAt: "2026-05-10T12:02:00.000Z",
      }),
      {
        type: "message_delete",
        time: "2026-05-10T12:03:00.000Z",
        guildId: "g",
        channelId: "c",
        messageId: "m2",
        payload: { deletedAt: "2026-05-10T12:03:00.000Z" },
      },
      createMessageEvent(message("m3", "bot-self", "Self Bot", "my reply", true)),
      createMessageEvent(message("m4", "bot-other", "Other Bot", "other reply", true)),
    ];

    const transcript = buildTranscript(events, {
      guildId: "g",
      channelId: "c",
      targetMessageIds: ["m2"],
      timezone: "UTC",
      botUserId: "bot-self",
    });

    expect(transcript).toContain('<msg id="m2" author="min"');
    expect(transcript).toContain('edited="2026-05-10T12:02:00.000+00:00"');
    expect(transcript).toMatch(/<msg\b[^>]*\bdeleted\b/);
    expect(transcript).toMatch(/<msg\b[^>]*\btarget\b/);
    expect(transcript).toContain("<reply");
    const replyBlock = transcript.match(/<reply\b[\s\S]*?<\/reply>/)?.[0] ?? "";
    expect(replyBlock).not.toContain("uid=");
    expect(replyBlock).toContain("ra1");
    expect(replyBlock).toContain("reply-embed");
    expect(transcript).toContain("<atts>");
    expect(transcript).toContain("<embeds>");
    expect(transcript).toContain("<rxs>");
    expect(transcript).toContain("<deleted");
    expect(transcript).toMatch(/<msg\b[^>]*id="m3"[^>]*\bme>/);
    expect(transcript).toMatch(/<msg\b[^>]*id="m4"[^>]*\bbot>/);
    expect(transcript).not.toContain(" other");
  });
});

function message(id: string, userId: string, name: string, content: string, isBot = false) {
  return createMessage(id, {
    guildId: "g",
    channelId: "c",
    author: { id: userId, username: name, displayName: name, isBot },
    content,
    cleanContent: content,
    createdAt: "2026-05-10T12:00:00.000Z",
  });
}
