export type SearchProvider = { kind: "tavily"; apiKey: string };

export type SearchResult = {
  answer?: string;
  results: Array<{ title: string; url: string; content: string }>;
};

export async function searchInternet(
  params: { query: string },
  provider: SearchProvider,
): Promise<SearchResult> {
  switch (provider.kind) {
    case "tavily":
      return searchViaTavily(params.query, provider.apiKey);
  }
}

async function searchViaTavily(query: string, apiKey: string): Promise<SearchResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, max_results: 5, search_depth: "basic" }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };
    return {
      ...(data.answer ? { answer: data.answer } : {}),
      results: (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        content: r.content ?? "",
      })),
    };
  } finally {
    clearTimeout(timeout);
  }
}
