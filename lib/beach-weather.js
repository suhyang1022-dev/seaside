const https = require("https");
const fs = require("fs");
const path = require("path");
const { URLSearchParams } = require("url");

const BEACH_API = "https://apis.data.go.kr/1360000/BeachInfoservice";
const CACHE_MS = 10 * 60 * 1000;

const SKY_MAP = { 1: "맑음", 3: "구름많음", 4: "흐림" };
const PTY_MAP = {
  0: "없음",
  1: "비",
  2: "비/눈",
  3: "눈",
  5: "빗방울",
  6: "빗방울눈날림",
  7: "눈날림",
};

const beachesData = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "beaches.json"), "utf8")
);

let weatherCache = null;

function getApiKey() {
  const key = process.env.BEACH_API_KEY;
  if (!key) {
    throw new Error("BEACH_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  return key;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (apiRes) => {
        let raw = "";
        apiRes.on("data", (chunk) => {
          raw += chunk;
        });
        apiRes.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

function beachApi(pathname, params) {
  const query = new URLSearchParams({
    ...params,
    serviceKey: getApiKey(),
    dataType: "JSON",
  });
  return fetchJson(`${BEACH_API}${pathname}?${query.toString()}`);
}

function nowKst() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  const h = kst.getUTCHours();
  const min = kst.getUTCMinutes();
  return {
    date: `${y}${m}${d}`,
    hour: h,
    min,
    timeLabel: `${h}시 ${String(min).padStart(2, "0")}분`,
    compact: `${y}${m}${d}${String(h).padStart(2, "0")}${String(min).padStart(2, "0")}`,
  };
}

function getUltraBaseTime() {
  const { date, hour, min } = nowKst();
  let baseHour = hour;
  if (min < 45) {
    baseHour -= 1;
    if (baseHour < 0) {
      return { base_date: date, base_time: "2330" };
    }
  }
  return {
    base_date: date,
    base_time: `${String(baseHour).padStart(2, "0")}30`,
  };
}

function normalizeItems(payload) {
  const items = payload?.response?.body?.items?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function getRegion(lat) {
  if (lat < 34) return "제주·남해";
  if (lat < 36) return "남부";
  if (lat < 37.5) return "중부";
  return "북부";
}

function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

function toDegrees(rad) {
  return (rad * 180) / Math.PI;
}

function formatClock(hourFloat) {
  const totalMinutes = Math.round(hourFloat * 60);
  const hours = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function calcSunTimes(lat, lon, dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfYear = Math.floor((date - new Date(Date.UTC(year, 0, 1))) / 86400000) + 1;
  const lngHour = lon / 15;

  function solve(isSunrise) {
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const m = 0.9856 * t - 3.289;
    let l =
      m +
      1.916 * Math.sin(toRadians(m)) +
      0.02 * Math.sin(toRadians(2 * m)) +
      282.634;
    l = ((l % 360) + 360) % 360;

    let ra = toDegrees(Math.atan(0.91764 * Math.tan(toRadians(l))));
    ra = ((ra % 360) + 360) % 360;
    const lQuadrant = Math.floor(l / 90) * 90;
    const raQuadrant = Math.floor(ra / 90) * 90;
    ra = (ra + (lQuadrant - raQuadrant)) / 15;

    const sinDec = 0.39782 * Math.sin(toRadians(l));
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH =
      (Math.cos(toRadians(90.833)) - sinDec * Math.sin(toRadians(lat))) /
      (cosDec * Math.cos(toRadians(lat)));

    if (cosH > 1 || cosH < -1) return null;

    let h = isSunrise ? 360 - toDegrees(Math.acos(cosH)) : toDegrees(Math.acos(cosH));
    h /= 15;
    const tt = h + ra - 0.06571 * t - 6.622;
    let ut = tt - lngHour;
    ut = ((ut % 24) + 24) % 24;
    return ut + 9;
  }

  const sunrise = solve(true);
  const sunset = solve(false);
  if (sunrise == null || sunset == null) {
    return { sunrise: "-", sunset: "-" };
  }

  return {
    sunrise: formatClock(sunrise),
    sunset: formatClock(sunset),
  };
}

function normalizeSunTime(value) {
  if (!value || value === ":" || !/^\d{1,2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(":");
  return `${String(h).padStart(2, "0")}:${m}`;
}

function isRainy(ptyCode, rain) {
  if ([1, 2, 5, 6].includes(ptyCode)) return true;
  if (!rain || rain === "-" || rain === "0") return false;
  if (String(rain).includes("강수없음")) return false;
  return true;
}

function pickNearestForecast(items, nowCompact) {
  const grouped = {};
  for (const item of items) {
    const key = `${item.fcstDate}${item.fcstTime}`;
    if (key < nowCompact.slice(0, 12)) continue;
    if (!grouped[item.category]) grouped[item.category] = item;
  }
  return grouped;
}

async function fetchBeachWeather(beach, baseDate, baseTime, searchTime, nowCompact) {
  const [ultra, wave, water, sun] = await Promise.all([
    beachApi("/getUltraSrtFcstBeach", {
      beach_num: String(beach.code),
      base_date: baseDate,
      base_time: baseTime,
      numOfRows: "60",
      pageNo: "1",
    }),
    beachApi("/getWhBuoyBeach", {
      beach_num: String(beach.code),
      searchTime,
      numOfRows: "10",
      pageNo: "1",
    }),
    beachApi("/getTwBuoyBeach", {
      beach_num: String(beach.code),
      searchTime,
      numOfRows: "10",
      pageNo: "1",
    }),
    beachApi("/getSunInfoBeach", {
      beach_num: String(beach.code),
      base_date: baseDate,
      numOfRows: "10",
      pageNo: "1",
    }),
  ]);

  const forecast = pickNearestForecast(normalizeItems(ultra), nowCompact);
  const waveItem = normalizeItems(wave)[0];
  const waterItem = normalizeItems(water)[0];
  const sunItem = normalizeItems(sun)[0];

  const skyCode = Number(forecast.SKY?.fcstValue ?? "");
  const ptyCode = Number(forecast.PTY?.fcstValue ?? "");
  const temp = forecast.T1H?.fcstValue ?? "-";
  const humidity = forecast.REH?.fcstValue ?? "-";
  const wind = forecast.WSD?.fcstValue ?? "-";
  const rain = forecast.RN1?.fcstValue ?? "-";

  const apiSunrise = normalizeSunTime(sunItem?.sunrise);
  const apiSunset = normalizeSunTime(sunItem?.sunset);
  const calculatedSun = calcSunTimes(beach.lat, beach.lon, baseDate);

  return {
    code: beach.code,
    name: beach.name,
    region: getRegion(beach.lat),
    lat: beach.lat,
    lon: beach.lon,
    temperature: temp,
    humidity,
    wind,
    rain,
    sky: SKY_MAP[skyCode] || (skyCode ? String(skyCode) : "-"),
    precipitation: PTY_MAP[ptyCode] || (ptyCode ? String(ptyCode) : "-"),
    ptyCode,
    isRaining: isRainy(ptyCode, rain),
    wave: waveItem?.wh ? `${waveItem.wh}m` : "-",
    waterTemp: waterItem?.tw ? `${waterItem.tw}°C` : "-",
    sunrise: apiSunrise || calculatedSun.sunrise,
    sunset: apiSunset || calculatedSun.sunset,
    forecastTime: forecast.T1H
      ? `${forecast.T1H.fcstDate.slice(0, 4)}-${forecast.T1H.fcstDate.slice(4, 6)}-${forecast.T1H.fcstDate.slice(6, 8)} ${forecast.T1H.fcstTime.slice(0, 2)}:${forecast.T1H.fcstTime.slice(2, 4)}`
      : "-",
  };
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

async function getBeachWeather() {
  if (weatherCache && Date.now() - weatherCache.at < CACHE_MS) {
    return weatherCache.data;
  }

  const kst = nowKst();
  const { base_date, base_time } = getUltraBaseTime();
  const searchTime = kst.compact;

  const beaches = await mapWithConcurrency(beachesData.major, 12, async (beach) => {
    try {
      return await fetchBeachWeather(beach, base_date, base_time, searchTime, kst.compact);
    } catch (error) {
      return {
        code: beach.code,
        name: beach.name,
        region: getRegion(beach.lat),
        error: error.message,
      };
    }
  });

  const data = {
    updatedAt: new Date().toISOString(),
    baseDate: base_date,
    baseTime: base_time,
    kstTime: kst.timeLabel,
    count: beaches.length,
    beaches: beaches.sort(
      (a, b) => a.region.localeCompare(b.region, "ko") || a.name.localeCompare(b.name, "ko")
    ),
  };

  weatherCache = { at: Date.now(), data };
  return data;
}

function clearCache() {
  weatherCache = null;
}

function getBeaches() {
  return beachesData.major;
}

module.exports = {
  getBeachWeather,
  clearCache,
  getBeaches,
};
