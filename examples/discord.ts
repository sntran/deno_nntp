import type { ConnInfo } from "https://deno.land/std@0.144.0/http/server.ts";
import {
  Handler,
  Router,
} from "https://raw.githubusercontent.com/sntran/hack-n-slash/main/mod.ts";
import { Pool, Resource } from "https://deno.land/x/pool@v0.1.0/mod.ts";
import { Client } from "../mod.ts";

interface Current {
  group?: string;
  article?: number;
}

// Because we are using a pool, the next client instance won't have the
// currently selected newsgroup and current article number set.
// Therefore, we use an internal state to keep track of them, and use
// them to set the new client's state.
const current: Current = {
  // Currently selected newsgroup
  group: "",
  // Current article number
  article: 0,
};

const pool = new Pool<Client>({
  min: 1,
  max: 10,
  idle: 1000 * 60 * 10,
  // defined how to create a resource
  creator: async (_pool: Pool<Client>, _resourceID: string) => {
    const client: Client = await Client.connect({
      hostname: Deno.env.get("NNTP_HOSTNAME"),
      port: Number(Deno.env.get("NNTP_PORT")),
    });
    await client.authinfo(
      Deno.env.get("NNTP_USER") || "",
      Deno.env.get("NNTP_PASS"),
    );

    if (current.group) {
      await client.group(current.group);
    }

    if (current.article) {
      await client.stat(current.article);
    }

    return client;
  },
  // defined how to destroy a resource
  destroyer: async (_pool: Pool<Client>, resource: Resource<Client>) => {
    await resource.resource.close();
  },
});

/** Shortcut */
function command(command: string): Handler {
  return async (
    _r: Request,
    _c: ConnInfo,
    params: Record<string, string> = {},
  ) => {
    const client = await pool.get();
    const response: Response = await client.request(
      command,
      ...Object.values(params).map(decodeURIComponent),
    );
    const { status, statusText, headers } = response;

    switch (status) {
      case 211: // GROUP and LISTGROUP
        current.group = params.name;
        break;
      case 220: // ARTICLE
      case 221: // HEAD
      case 222: // BODY
      case 223: { // LAST, NEXT, STAT
        const [, n, _messageId] =
          statusText.match(/([\d]+)\s(<[\x21-\x7E]+>)/) || [];
        current.article = Number(n);
        break;
      }
    }

    let body = "";

    headers.forEach((value: string, name: string) => {
      body += `${name}: ${value}\r\n`;
    });

    // If `body` has content, we have some headers.
    if (body) {
      body += "\r\n";
    }

    body += await response.text();

    // Prepends with response code and response text.
    body = `${status} ${statusText}` + (body ? `\r\n${body}.` : "");

    return new Response(body, {
      headers: {
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}

console.log("Listening on http://localhost:8000");
// @ts-ignore valid option
const slasher: Router = new Router({
  serveOnly: true,
  "/": (_req: Request) => new Response("Hello Usenet"),
  "/update": () => slasher.registerApplicationCommands(),
  "/capabilities": command("capabilities"),
  "/group/:name": command("group"),
  "/listgroup/:name": command("listgroup"),
  "/last": command("last"),
  "/next": command("next"),
  "/article/:id": command("article"),
  "/head/:id": command("head"),
  "/body/:id": command("body"),
  "/stat/:id": command("stat"),
  "/date": command("date"),
  "/help": command("help"),
  "/newgroups/:date/:time": command("newsgroups"),
  "/newnews/:wildmat/:date/:time": command("newnews"),
});

globalThis.addEventListener("unload", (_event: Event): void => {
  pool.destroy();
});
