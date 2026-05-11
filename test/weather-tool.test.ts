import { afterEach, describe, expect, it, vi } from "vitest";
import { weatherLookup } from "../src/tools/weather.js";

describe("weather tool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves a location and returns Open-Meteo forecast data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL) => {
        if (String(url).includes("geocoding-api")) {
          return Response.json({
            results: [{ name: "Seoul", country: "South Korea", latitude: 37.56, longitude: 126.97 }],
          });
        }
        return Response.json({
          timezone: "Asia/Seoul",
          current: {
            time: "2026-05-11T12:00",
            temperature_2m: 21,
            apparent_temperature: 22,
            precipitation: 0,
            wind_speed_10m: 3,
          },
          daily: {
            time: ["2026-05-11"],
            temperature_2m_max: [24],
            temperature_2m_min: [15],
            precipitation_sum: [1.2],
          },
        });
      }),
    );

    const result = await weatherLookup({ location: "Seoul", date: "2026-05-11" });

    expect(result.location).toBe("Seoul, South Korea");
    expect(result.current?.temperatureC).toBe(21);
    expect(result.daily?.[0]?.maxTemperatureC).toBe(24);
    expect(result.summary).toContain("currently 21C");
  });
});
