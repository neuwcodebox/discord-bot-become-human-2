---
name: weather
description: Look up current weather or forecasts. Use when a user asks about weather, temperature, rain, wind, forecast, or climate conditions for any location or date.
---

# Weather

Two free services, no API keys needed. Use `sandbox_exec` to run curl.

## wttr.in (primary)

Quick one-liner:
```bash
curl -s "wttr.in/Seoul?format=3"
# Output: Seoul: ⛅️ +21°C
```

Compact format with humidity and wind:
```bash
curl -s "wttr.in/Seoul?format=%l:+%c+%t+%h+%w"
```

Full 3-day forecast:
```bash
curl -s "wttr.in/Seoul?T"
```

Tips:
- URL-encode spaces: `wttr.in/New+York`
- Airport codes: `wttr.in/ICN`
- Units: `?m` (metric) `?u` (USCS)
- Today only: `?1` · Current only: `?0`

## Open-Meteo (fallback, JSON)

Find coordinates first, then query:
```bash
# 1. Geocode
curl -s "https://geocoding-api.open-meteo.com/v1/search?name=Seoul&count=1&format=json"

# 2. Forecast (use lat/lon from step 1)
curl -s "https://api.open-meteo.com/v1/forecast?latitude=37.56&longitude=126.97&current_weather=true&timezone=auto"
```

## Response
Include the location and time period in your reply so the user knows what data you retrieved.
