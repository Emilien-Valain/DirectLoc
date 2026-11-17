import http from "http";

export type CapturedEvent = {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
};

/** Faux PostHog : collecte les événements serveur envoyés à POSTHOG_HOST (port 3998). */
export async function startPosthogSink(port = 3998) {
  const events: CapturedEvent[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        events.push(JSON.parse(body));
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"status":"Ok"}');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  return {
    events,
    find: (name: string) => events.filter((e) => e.event === name),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
