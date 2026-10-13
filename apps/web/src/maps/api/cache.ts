import _ from "lodash";
import { toast } from "react-toastify";

import { CacheType } from "./types";

// Cache API requires a secure context (HTTPS/localhost). On plain HTTP (e.g.
// local network IP) it is undefined — callers already fall back to plain fetch.
const cachesAvailable = typeof caches !== "undefined";

const determineQuestionCache = _.memoize(() => caches.open(CacheType.CACHE));
const determineZoneCache = _.memoize(() => caches.open(CacheType.ZONE_CACHE));
const determinePermanentCache = _.memoize(() =>
    caches.open(CacheType.PERMANENT_CACHE),
);

const inFlightFetches = new Map<string, Promise<Response>>();

export const determineCache = async (cacheType: CacheType) => {
    if (!cachesAvailable) throw new Error("Cache API unavailable (non-secure context)");
    switch (cacheType) {
        case CacheType.CACHE:
            return await determineQuestionCache();
        case CacheType.ZONE_CACHE:
            return await determineZoneCache();
        case CacheType.PERMANENT_CACHE:
            return await determinePermanentCache();
    }
};

export const cacheFetch = async (
    url: string,
    loadingText?: string,
    cacheType: CacheType = CacheType.CACHE,
    fetchOptions?: RequestInit,
) => {
    try {
        const cache = await determineCache(cacheType);

        const cachedResponse = await cache.match(url);
        if (cachedResponse) {
            if (!cachedResponse.ok) {
                await cache.delete(url);
            } else {
                return cachedResponse.clone();
            }
        }

        const inflightKey = `${cacheType}:${url}`;
        const existingFetch = inFlightFetches.get(inflightKey);
        if (existingFetch) {
            const response = await existingFetch;
            return response.clone();
        }

        const fetchAndMaybeCache = async () => {
            const response = await fetch(url, fetchOptions);
            if (response.ok) {
                await cache.put(url, response.clone());
            } else {
                await cache.delete(url);
            }
            return response;
        };

        const fetchPromise = fetchAndMaybeCache();
        inFlightFetches.set(inflightKey, fetchPromise);

        try {
            const response = await (loadingText
                ? toast.promise(fetchPromise, {
                      pending: loadingText,
                  })
                : fetchPromise);

            return response.clone();
        } finally {
            inFlightFetches.delete(inflightKey);
        }
    } catch {
        // Cache API unavailable (non-secure context) — fall through

        return fetch(url, fetchOptions);
    }
};

export const clearCache = async (cacheType: CacheType = CacheType.CACHE) => {
    try {
        const cache = await determineCache(cacheType);
        await cache.keys().then((keys) => {
            keys.forEach((key) => {
                cache.delete(key);
            });
        });
    } catch {
        // Cache API unavailable (non-secure context) — fall through
    }
};
