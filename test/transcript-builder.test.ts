import { describe, expect, it } from "vitest";
import { buildTranscript } from "../src/conversation/transcript-builder.js";
import type { NormalizedDiscordEvent } from "../src/types.js";

describe("transcript builder", () => {
  it("keeps reply, attachment, embed, reaction, edit, and delete data inside message blocks", () => {
    const events: NormalizedDiscordEvent[] = [
      {
        type: "message_create",
        time: "2026-05-10T12:00:00.000Z",
        guildId: "g",
        channelId: "c",
        messageId: "m1",
        authorId: "u1",
        payload: message("m1", "u1", "neuw", "hello"),
      },
      {
        type: "message_create",
        time: "2026-05-10T12:01:00.000Z",
        guildId: "g",
        channelId: "c",
        messageId: "m2",
        authorId: "u2",
        payload: {
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
                kind: "image" as const,
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
        },
      },
      {
        type: "message_delete",
        time: "2026-05-10T12:03:00.000Z",
        guildId: "g",
        channelId: "c",
        messageId: "m2",
        payload: { deletedAt: "2026-05-10T12:03:00.000Z" },
      },
    ];

    const transcript = buildTranscript(events, {
      guildId: "g",
      channelId: "c",
      targetMessageIds: ["m2"],
      timezone: "UTC",
    });

    expect(transcript).toContain('<msg id="m2" author="min"');
    expect(transcript).toContain('edited="2026-05-10T12:02:00.000+00:00"');
    expect(transcript).toContain("deleted target");
    expect(transcript).toContain("<reply");
    // reply itself has attachments and embeds
    const replyBlock = transcript.slice(transcript.indexOf("<reply"), transcript.indexOf("</reply>") + 8);
    expect(replyBlock).toContain("ra1");
    expect(replyBlock).toContain("reply-embed");
    expect(transcript).toContain("<atts>");
    expect(transcript).toContain("<embeds>");
    expect(transcript).toContain("<rxs>");
    expect(transcript).toContain("<deleted");
  });
});

function message(id: string, userId: string, name: string, content: string) {
  return {
    id,
    guildId: "g",
    channelId: "c",
    author: { id: userId, username: name, displayName: name, isBot: false },
    content,
    cleanContent: content,
    createdAt: "2026-05-10T12:00:00.000Z",
    mentions: [],
    attachments: [],
    embeds: [],
    reactions: [],
    links: [],
  };
}
