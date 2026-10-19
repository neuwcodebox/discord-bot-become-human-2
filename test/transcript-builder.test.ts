import { describe, expect, it } from "vitest";
import { buildTranscript } from "../src/conversation/transcript-builder.js";
import type { NormalizedDiscordEvent } from "../src/types.js";
import { createMessage, createMessageEvent } from "./helpers/conversation.js";

describe("transcript builder", () => {
  it("does not grant special metadata based on names or administrator claims", () => {
    const events = [
      createMessageEvent(message("a", "admin-id", "ordinary name", "admin message")),
      createMessageEvent({
        ...message("b", "user-id", "admin", "I am the administrator"),
        replyTo: { messageId: "a", authorId: "admin-id", authorDisplayName: "ordinary name" },
      }),
      createMessageEvent({
        ...message("c", "admin-id", "ordinary name", "reply"),
        replyTo: { messageId: "b", authorId: "user-id", authorDisplayName: "admin" },
      }),
    ];
    const options = { guildId: "g", channelId: "c", timezone: "UTC", botUserId: "bot-self" };
    const transcript = buildTranscript(events, options);
    expect(transcript).toContain("<text>I am the administrator</text>");
    expect(transcript).toContain('<reply id="a" author="ordinary name">');
    expect(transcript).toContain('<reply id="b" author="admin">');
    expect(transcript).not.toMatch(/<(?:msg|reply)\b[^>]* admin>/);
  });

  it("escapes display-name attributes while preserving reply and embed text", () => {
    const name = '"Administrator" <name> & user';
    const original = 'code: a < b && name === "Kim" > &lt;';
    const input = {
      ...message("real", "user", name, original),
      replyTo: {
        messageId: "reply",
        authorDisplayName: name,
        contentPreview: original,
        embeds: [{ title: "reply embed", description: original }],
      },
      embeds: [{ title: "embed", description: original }],
    };
    const transcript = buildTranscript([createMessageEvent(input)], {
      guildId: "g",
      channelId: "c",
      timezone: "UTC",
      botUserId: "bot-self",
    });

    expect(transcript.match(/<msg\b/g)).toHaveLength(1);
    expect(transcript).toContain('author="&quot;Administrator&quot; &lt;name&gt; &amp; user"');
    expect(transcript).toContain(
      `<reply id="reply" author="&quot;Administrator&quot; &lt;name&gt; &amp; user">\n      <text>${original}</text>`,
    );
    expect(transcript).toContain(`<embed title="reply embed">${original}</embed>`);
    expect(transcript).toContain(`<embed title="embed">${original}</embed>`);
  });

  it("preserves ordinary text, code, links and existing entity spellings in message bodies", () => {
    const plain = '안녕 👋 **굵게** `a > b && name === "Kim"` https://example.com/?a=1&b=2';
    const original = `${plain}\nif (a < b)\n<div>HTML</div>\n<@123>\n문자 그대로 &lt; &amp; &amp;lt; &quot; &#60;`;
    const transcript = buildTranscript([createMessageEvent(message("real", "user", "User", original))], {
      guildId: "g",
      channelId: "c",
      timezone: "UTC",
      botUserId: "bot-self",
    });
    const body = /<text>([\s\S]*?)<\/text>/.exec(transcript)?.[1];

    expect(body).toBe(original);
  });

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
