export async function weatherLookup(input: {
  location: string;
  date?: string;
}): Promise<{ summary: string }> {
  return {
    summary:
      `Weather lookup requested for ${input.location}${input.date ? ` on ${input.date}` : ""}. ` +
      "Configure a concrete weather provider before using live forecasts.",
  };
}
