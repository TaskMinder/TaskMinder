/// <reference lib="webworker" />
const sw = globalThis as unknown as ServiceWorkerGlobalScope;

function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const request = indexedDB.open("app", 1);

    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };

    request.onsuccess = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (db.objectStoreNames.contains("meta")) {
        res(db);
      }
      else {
        db.close();
        indexedDB.deleteDatabase("app");
        openIndexedDB().then(res => res);
      }
    };

    request.onerror = event => {
      rej((event.target as IDBOpenDBRequest).error);
    };
  });
}

const CORE_GLOBAL = ["/global/global.js", "/global/global.css"];
const CORE_PAGES = ["main", "events", "homework", "uploads", "settings"]
  .flatMap(p => ["/" + p, `/pages/${p}/${p}.js`, `/pages/${p}/${p}.css`]);
const CORE_SNIPPETS = ["bottombar", "colorPicker", "fileViewer", "footer", "loadingBar", "navbar", "richInput", "richTextarea"]
  .map(s => `/snippets/${s}/${s}.js`);
const CORE_ASSETS = [
  "/static/manifest.json",
  "/assets/ios-share-icon.svg",
  "/assets/ios-add-icon.svg",
  "/assets/app-icon.png",
  "/static/favicon.ico", 
  "/assets/fonts/Quicksand-VariableFont_wght.ttf"
];
const CORE_VENDOR = [
  "/jquery/jquery.min.js",
  "/bootstrap/bootstrap.bundle.min.js",
  "/qrcode/qrcode.min.js",
  "/socket/socket.io.esm.min.js",
  "/fontawesome/fonts/fa-solid-900.woff2",
  "/fontawesome/fonts/fa-brands-400.woff2",
  "/fontawesome/fonts/fa-regular-400.woff2"
]
  .map(v => "/vendor" + v);
const CORE_APP = new Set([
  ...CORE_GLOBAL,
  ...CORE_PAGES,
  ...CORE_SNIPPETS,
  ...CORE_ASSETS,
  ...CORE_VENDOR
]);

const API_ROUTES = [
  "/csrf-token",
  "/bootstrap",
  "/api"
];

sw.addEventListener("install", () => {
  sw.skipWaiting();
});

sw.addEventListener("activate", async () => {
  sw.clients.claim();
  await fetchBootstrap();
});

async function removeOutdatedCaches(version: string): Promise<void> {
  const CORE_CACHE = "core-v" + version;
  const API_CACHE = "api-v" + version;
  (await caches.keys())
    .filter(name => ! [CORE_CACHE, API_CACHE].includes(name))
    .forEach(name => caches.delete(name));
}

type Bootstrap = { maintenance: boolean, online: boolean, version: string, cacheEnabled: boolean, maintenanceHtml: string, classJoined: boolean }
let bootstrap: Bootstrap | null = null;

async function getCachedBootstrap(db: IDBDatabase): Promise<Bootstrap | undefined> {
  const request = db.transaction("meta", "readonly").objectStore("meta").get("bootstrap");
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as Bootstrap | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function fetchBootstrap(): Promise<Bootstrap> {
  const db = await openIndexedDB();
  try {
    const res = await (await fetch("/bootstrap")).json() as Bootstrap;
    if (res.maintenance) {
      const cachedBootstrap = await getCachedBootstrap(db);
      if (cachedBootstrap) res.version = cachedBootstrap.version;
    }
    res.online = true;
    db.transaction("meta", "readwrite").objectStore("meta").put(res, "bootstrap");
    await removeOutdatedCaches(res.version);
    bootstrap = res;
    return res;
  }
  catch {
    const cachedBootstrap = await getCachedBootstrap(db);
    const res: Bootstrap = cachedBootstrap ? { ...cachedBootstrap, online: false } : {
      maintenance: false,
      online: false,
      version: "offline",
      cacheEnabled: false,
      maintenanceHtml: "",
      classJoined: false
    };
    db.transaction("meta", "readwrite").objectStore("meta").put(res, "bootstrap");
    bootstrap = res;
    return res;
  }
}

async function handleFetch(ev: FetchEvent): Promise<Response> {
  const req = ev.request;

  const url = new URL(req.url);
  const path = url.pathname;

  const b = req.mode === "navigate" ? await fetchBootstrap() : bootstrap ?? await fetchBootstrap();

  const CORE_CACHE = "core-v" + b.version;
  const API_CACHE = "api-v" + b.version;
  const CACHE_ENABLED = b.cacheEnabled;

  if (path === "/bootstrap") {
    return new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json;charset=utf-8" } });
  }
  if (req.method === "GET") {
    if (/\/api\/uploads\/\d+/.exec(path)) {
      try {
        return await fetch(req);
      }
      catch {
        return new Response(`Fetch failed for ${req.method} ${url}`, { status: 503 });
      }
    }

    if (CORE_APP.has(path)) {
      const cache = await caches.open(CORE_CACHE);
      const cached = await cache.match(req);

      if (cached && (CACHE_ENABLED || b.maintenance || !b.online)) {
        return cached;
      }

      try {
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      }
      catch {
        return cached || new Response(`Fetch failed for ${req.method} ${url}`, { status: 503 });
      }
    }

    if (API_ROUTES.some(r => path.startsWith(r))) {
      const cache = await caches.open(API_CACHE);
      try {
        if (b.maintenance || !b.online) throw new Error("Maintenance or offline");

        const response = await fetch(req);

        if (response.ok) await cache.put(req, response.clone());

        const db = await openIndexedDB();
        db.transaction("meta", "readwrite").objectStore("meta").put(Date.now(), "lastUpdated");

        return response;
      }
      catch {
        const cached = await cache.match(req);
        return cached || new Response(`Fetch failed for ${req.method} ${url}`, { status: 503 });
      }
    }
  }
  const res = await fetch(req);
  return res;
}

sw.addEventListener("fetch", (ev: FetchEvent) => {
  ev.respondWith(handleFetch(ev));
});

sw.addEventListener("message", async () => {
});
