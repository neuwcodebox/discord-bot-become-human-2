export type WeatherLookupInput = {
  location: string;
  date?: string;
};

export type WeatherLookupResult = {
  location: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  current?: {
    time: string;
    temperatureC?: number;
    apparentTemperatureC?: number;
    precipitationMm?: number;
    windSpeedKmh?: number;
  };
  daily?: Array<{
    date: string;
    minTemperatureC?: number;
    maxTemperatureC?: number;
    precipitationMm?: number;
  }>;
  summary: string;
};

export async function weatherLookup(input: WeatherLookupInput): Promise<WeatherLookupResult> {
  const place = await geocode(input.location);
  const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
  forecastUrl.searchParams.set("latitude", String(place.latitude));
  forecastUrl.searchParams.set("longitude", String(place.longitude));
  forecastUrl.searchParams.set("timezone", "auto");
  forecastUrl.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,wind_speed_10m");
  forecastUrl.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum");
  if (input.date) {
    forecastUrl.searchParams.set("start_date", input.date);
    forecastUrl.searchParams.set("end_date", input.date);
  }

  const forecast = (await fetchJson(forecastUrl)) as OpenMeteoForecast;
  const result: WeatherLookupResult = {
    location: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
    ...(forecast.timezone ? { timezone: forecast.timezone } : {}),
    summary: "",
  };
  if (forecast.current) {
    result.current = {
      time: forecast.current.time,
      ...(forecast.current.temperature_2m === undefined
        ? {}
        : { temperatureC: forecast.current.temperature_2m }),
      ...(forecast.current.apparent_temperature === undefined
        ? {}
        : { apparentTemperatureC: forecast.current.apparent_temperature }),
      ...(forecast.current.precipitation === undefined
        ? {}
        : { precipitationMm: forecast.current.precipitation }),
      ...(forecast.current.wind_speed_10m === undefined
        ? {}
        : { windSpeedKmh: forecast.current.wind_speed_10m }),
    };
  }
  if (forecast.daily) {
    result.daily = forecast.daily.time.map((date, index) => ({
      date,
      ...(forecast.daily?.temperature_2m_max[index] === undefined
        ? {}
        : { maxTemperatureC: forecast.daily.temperature_2m_max[index] }),
      ...(forecast.daily?.temperature_2m_min[index] === undefined
        ? {}
        : { minTemperatureC: forecast.daily.temperature_2m_min[index] }),
      ...(forecast.daily?.precipitation_sum[index] === undefined
        ? {}
        : { precipitationMm: forecast.daily.precipitation_sum[index] }),
    }));
  }
  result.summary = summarizeWeather(result, input.date);
  return result;
}

async function geocode(location: string): Promise<{ name: string; latitude: number; longitude: number }> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  const data = (await fetchJson(url)) as {
    results?: Array<{
      name: string;
      country?: string;
      admin1?: string;
      latitude: number;
      longitude: number;
    }>;
  };
  const first = data.results?.[0];
  if (!first) throw new Error(`No weather location found for: ${location}`);
  return {
    name: [first.name, first.admin1, first.country].filter(Boolean).join(", "),
    latitude: first.latitude,
    longitude: first.longitude,
  };
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Weather request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function summarizeWeather(result: WeatherLookupResult, date?: string): string {
  const day = date ? result.daily?.find((entry) => entry.date === date) : result.daily?.[0];
  const current = result.current;
  const parts = [`${result.location}`];
  if (current?.temperatureC !== undefined) parts.push(`currently ${current.temperatureC}C`);
  if (current?.apparentTemperatureC !== undefined) parts.push(`feels like ${current.apparentTemperatureC}C`);
  if (day?.minTemperatureC !== undefined && day.maxTemperatureC !== undefined) {
    parts.push(`${day.minTemperatureC}-${day.maxTemperatureC}C`);
  }
  if (day?.precipitationMm !== undefined) parts.push(`${day.precipitationMm}mm precipitation`);
  return parts.join(", ");
}

type OpenMeteoForecast = {
  timezone?: string;
  current?: {
    time: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    precipitation?: number;
    wind_speed_10m?: number;
  };
  daily?: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
  };
};
