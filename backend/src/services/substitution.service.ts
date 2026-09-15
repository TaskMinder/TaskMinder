import { redisClient, CACHE_KEY_PREFIXES, generateCacheKey } from "../config/redis.js";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import logger from "../config/logger.js";
import { Session, SessionData } from "express-session";
import { prisma } from "../config/prisma.js";
import { BigIntreplacer } from "../utils/validate.functions.js";

type SubstitutionData = {
  plan1: { substitutions: unknown; date: string };
  plan2: { substitutions: unknown; date: string };
  updated: string;
};

// 10 min for offpeak cache expiration
const SUBSTITUTION_OFFPEAK_TTL_SECONDS = 10 * 60;
// 1 min for peak time prefetch ttl cache expiration
const SUBSTITUTION_PREFETCH_TTL_SECONDS = 1 * 60;
// max 5 substitution fetches at the same time to DSBMobile server
const SUBSTITUTION_PREFETCH_CONCURRENCY = 5;

// peak time during workdays (monday - friday) between 6 and 9 am
const isPeakSubstitutionWindow = (date: Date = new Date()): boolean => {
  const day = date.getDay();
  const hour = date.getHours();
  const isWeekday = day >= 1 && day <= 5;
  const isMorningWindow = hour >= 6 && hour < 9;
  return isWeekday && isMorningWindow;
};

// get the DSBMobile server response and return the timetables
async function fetchFromDSBMobileServer(authId: string): Promise<{
    plan1Url: string;
    plan2Url: string;
}> {
  const timetablesUrl = `https://mobileapi.dsbcontrol.de/dsbtimetables?authid=${authId}`;
  const timetablesRes = await fetch(timetablesUrl, { signal: AbortSignal.timeout(8_000) });
  if (!timetablesRes.ok) {
    throw new Error(`DSB timetables request failed with status ${timetablesRes.status}`);
  }
  const timetablesData: { Childs: { Detail: string }[] }[] = await timetablesRes.json();
  const plan1Url = timetablesData[0]?.Childs[0]?.Detail;
  const plan2Url = timetablesData[2]?.Childs[0]?.Detail;

  if (!plan1Url || !plan2Url) {
    throw new Error("Could not retrieve timetable URLs from DSB.");
  }
  return { plan1Url, plan2Url };
}

export async function loadSubstitutionData(
  dsbMobileUser: string, 
  dsbMobilePassword: string, 
  cacheKey: string,
  ttlSeconds: number
): Promise<SubstitutionData | "No data"> {
  try {
    const generalReqData = "appversion=&bundleid=&osversion=&pushid=";
    const authUrl = `https://mobileapi.dsbcontrol.de/authid?user=${dsbMobileUser}&password=${dsbMobilePassword}&${generalReqData}`;
    const authRes = await fetch(authUrl, { signal: AbortSignal.timeout(10_000) });
    if (!authRes.ok) {
      throw new Error(`DSB auth request failed with status ${authRes.status}`);
    }
    const authId = await authRes.json();
    if (!authId) {
      throw new Error("The DSB credentials did not return a valid authId.");
    }

    const { plan1Url, plan2Url } = await fetchFromDSBMobileServer(authId);
    
    const substitutionEntryKeys = ["class", "lesson", "time", "subject", "text", "teacher", "teacherOld", "room", "type"];
    const substitutionsResult: SubstitutionData = {
      plan1: { substitutions: null, date: "" },
      plan2: { substitutions: null, date: "" },
      updated: ""
    };

    for (const id of [1, 2] as const) {
      const planData: { [key: string]: string }[] = [];
      const url = (id === 1) ? plan1Url : plan2Url;
      const planRes = await fetch(url);
      if (!planRes.ok) {
        throw new Error(`DSB plan${id} request failed with status ${planRes.status}`);
      }
      const planBuffer = await planRes.arrayBuffer();
      const planHtml = iconv.decode(Buffer.from(planBuffer), "ISO-8859-1");
      const $ = cheerio.load(planHtml);

      $(".mon_list tr:not(:nth-child(1))").each((_, substitutionEntry) => {
        const data: { [key: string]: string } = {};
        $(substitutionEntry).find("td").each((j, substitutionEntryData) => {
          const val = $(substitutionEntryData).text().trim();
          data[substitutionEntryKeys[j]] = ["---", " ", ""].includes(val) ? "" : val;
        });
        planData.push(data);
      });

      substitutionsResult[`plan${id}`].substitutions = planData;
      substitutionsResult[`plan${id}`].date = $(".mon_title").text().split(" ")[0];
      substitutionsResult.updated = $(".mon_head p").text().split("Stand: ")[1] || "";
    }

    logger.info(`Substitution successfully fetched for school: ${dsbMobileUser}, cacheKey: ${cacheKey}`);

    const cachePayload = {
      data: substitutionsResult,
      timestamp: Date.now()
    };
    await redisClient.set(cacheKey, JSON.stringify(cachePayload, BigIntreplacer), { expiration: { type: "EX", value: ttlSeconds } });
    
    return substitutionsResult;
  } 
  catch (error) {
    logger.warn(`Error fetching substitution data: ${error}`);
    
    // Try to get existing cached data instead of overwriting with "No data"
    try {
      const existingCache = await redisClient.get(cacheKey);
      if (existingCache) {
        // timestamp is ignored but is needed for parsing from redis
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { data, timestamp } = JSON.parse(existingCache);
        logger.info(`Serving stale data from cache due to fetch error for key ${cacheKey}`);
        return data;
      }
    } 
    catch (cacheErr) {
      logger.error(`Error reading from cache: ${cacheErr}`);
    }
    // Only return "No data" if there's no cached data at all
    return "No data";
  }
}

// During weekday mornings, prefer cached data and rely on the scheduled prefetch to keep it fresh.
// Outside the prefetch window, treat cached data as expired after 10 minutes and refresh on-demand.
// This keeps daytime requests fast while avoiding stale data off-peak.
// eslint-disable-next-line complexity
export async function getSubstitutionData(session: Session & Partial<SessionData>): Promise<{
    data: SubstitutionData | "No data";
    classFilterRegex: string | null;
}> {
  const substitutionClass = await prisma.class.findUnique({
    where: { classId: parseInt(session.classId!) }
  });

  if (!substitutionClass || !substitutionClass.dsbMobileActivated || !substitutionClass.dsbMobileUser || !substitutionClass.dsbMobilePassword) {
    return { data: "No data", classFilterRegex: null};
  }

  const { dsbMobileUser, dsbMobilePassword } = substitutionClass;

  // Transform class name to regex if it follows the "NumberLetter" pattern (e.g., "10d")
  // It generates a regex that matches the class number, any sequence of letters, the class letter,
  // and any sequence of letters after that. This allows matching class names like "10d", "10bd", "10abcd", etc.
  let classFilterRegex = substitutionClass.dsbMobileClass;
  if (classFilterRegex) {
    const match = classFilterRegex.match(/^(\d+)([a-zA-Z]+)$/);
    if (match) {
      const [, classNumber, classLetter] = match;
      classFilterRegex = `^${classNumber}[a-zA-Z]*${classLetter}[a-zA-Z]*`;
    }
  }
  // get the cache key of the school
  const cacheKey = generateCacheKey(CACHE_KEY_PREFIXES.SUBSTITUTIONS, dsbMobileUser.toString());
  const inPeakWindow = isPeakSubstitutionWindow();
  const ttlSeconds = inPeakWindow ? SUBSTITUTION_PREFETCH_TTL_SECONDS : SUBSTITUTION_OFFPEAK_TTL_SECONDS;

  const cachedEntry = await redisClient.get(cacheKey);

  if (!cachedEntry) {
    const data =  await loadSubstitutionData(dsbMobileUser, dsbMobilePassword, cacheKey, ttlSeconds);
    return {data, classFilterRegex: classFilterRegex};
  }

  const { data, timestamp } = JSON.parse(cachedEntry);

  if (!inPeakWindow && typeof timestamp === "number") {
    const isExpired = (Date.now() - timestamp) > (SUBSTITUTION_OFFPEAK_TTL_SECONDS * 1000);
    if (isExpired) {
      const refreshed = await loadSubstitutionData(dsbMobileUser, dsbMobilePassword, cacheKey, ttlSeconds);
      return { data: refreshed, classFilterRegex };
    }
  }

  return { data, classFilterRegex };
}

let isSubstitutionPrefetchRunning = false;

// Prefetch substitution data for all classes that have DSB Mobile enabled,
// fetches for classes with the same school dsbMobileUser will only be fetched once (shared cache) 
// with a small concurrency limit to reduce load on the DSB Mobile API.
export async function prefetchSubstitutionDataForAllClasses(): Promise<void> {
  if (isSubstitutionPrefetchRunning) {
    logger.warn("Substitution prefetch already running, skipping this cycle");
    return;
  }

  isSubstitutionPrefetchRunning = true;
  try {
    const classesWithDsb = await prisma.class.findMany({
      where: {
        dsbMobileActivated: true,
        dsbMobileUser: { not: null },
        dsbMobilePassword: { not: null }
      },
      select: {
        dsbMobileUser: true,
        dsbMobilePassword: true
      }
    });

    if (classesWithDsb.length === 0) {
      logger.info("Substitution prefetch skipped: no classes with DSB Mobile configured");
      return;
    }

    const uniqueClassesWithDsb = [
      ...new Map(classesWithDsb.map(c => [c.dsbMobileUser, c])).values()
    ];

    const results: PromiseSettledResult<void>[] = [];
    for (let i = 0; i < uniqueClassesWithDsb.length; i += SUBSTITUTION_PREFETCH_CONCURRENCY) {
      const batch = uniqueClassesWithDsb.slice(i, i + SUBSTITUTION_PREFETCH_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async entry => {
          const cacheKey = generateCacheKey(CACHE_KEY_PREFIXES.SUBSTITUTIONS, entry.dsbMobileUser!.toString());
          await loadSubstitutionData(entry.dsbMobileUser!, entry.dsbMobilePassword!, cacheKey, SUBSTITUTION_PREFETCH_TTL_SECONDS);
        })
      );
      results.push(...batchResults);
    }

    const failedCount = results.filter(result => result.status === "rejected").length;
    if (failedCount > 0) {
      logger.warn(`Substitution prefetch completed with ${failedCount} failures`);
    }
    else {
      logger.info(`Substitution prefetch completed for ${results.length} schools with ${classesWithDsb.length} classes in total`);
    }
  }
  finally {
    isSubstitutionPrefetchRunning = false;
  }
}

export default { getSubstitutionData };
