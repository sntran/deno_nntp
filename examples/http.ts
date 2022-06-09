#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * An example http server proxying NNTP.
 *
 * The server listens on port defined in `PORT` environment variable, or 8000.
 *
 * The server handles routes in pattern `/:command/:args` and forwards requests
 * to NNTP server with corresponding command.
 *
 * Authentication to NNTP server is done through HTTP Basic Authentication.
 *
 * To post, send the multi-line block data to `/post` or `/ihave/:msg-id`,
 * with any request headers needed.
 *
 * ## Examples
 *
 * ```shell
 * # Retrieves an article body by its message-id into a file.
 * curl "http://localhost:8000/body/message-id@nntp-server" > article.txt
 *
 * # Posts a new article using data from a file.
 * curl "http://localhost:8080/post" \
 *   --header "Message-ID: <abc@def>" \
 *   -H "From: poster@example.com" \
 *   --data-binary "@article.txt"
 * ```
 *
 * Note: When sending data with `curl`, use `--data-binary` instead of `--data`
 * to preserve linebreaks, which are essential for parsing.
 */
import { ConnInfo, serve } from "https://deno.land/std@0.142.0/http/server.ts";
import {
  getCookies,
  setCookie,
} from "https://deno.land/std@0.142.0/http/cookie.ts";
import { router } from "https://crux.land/router@0.0.12";
import { Article, Client } from "../mod.ts";

const {
  PORT = 8000,
  NNTP_HOSTNAME,
  NNTP_PORT,
} = Deno.env.toObject();

/**
 * Identity function that returns its argument.
 *
 * Can be used to filter out array with empty string element as the
 * result of `String.prototype.split`.
 *
 * # Examples
 *
 * ```ts
 * console.assert("".split("/").length !== 0);
 * console.assert("".split("/").filter(identity).length === 0);
 * ```
 */
function identity<T>(x: T): T {
  return x;
}

export async function handle(
  request: Request,
  _c: ConnInfo,
  { command, args = "" }: Record<string, string>,
) {
  //#region Authorization.
  const authorization = request.headers.get("Authorization");
  if (!authorization) {
    return new Response("401 Unauthorized", {
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "WWW-Authenticate": `Basic realm="Provider Login", charset="UTF-8"`,
      },
    });
  }

  const [, base64 = ""] = authorization.match(/^Basic\s+(.*)$/) || [];
  const [username, password] = atob(base64).split(":");

  const client = await await Client.connect({
    hostname: NNTP_HOSTNAME,
    port: Number(NNTP_PORT),
    ssl: true,
    logLevel: "DEBUG",
  });
  // Authenticates with provider.
  await client.authinfo(username, password);
  //#endregion Authorization

  // Checks if any group or article was selected before.
  const { group, article } = getCookies(request.headers);
  if (group) {
    await client.group(group);
  }
  if (article) {
    await client.stat(article);
  }

  const params = decodeURIComponent(args).split("/").filter(identity);

  let response: Response = new Response();
  if (request.body) {
    const article = new Article(request);
    // Cleans up HTTP headers.
    article.headers.delete("Accept");
    article.headers.delete("Authorization");
    article.headers.delete("Content-Length");
    article.headers.delete("Content-Type");
    article.headers.delete("Host");
    article.headers.delete("User-Agent");

    if (command === "post") {
      response = await client.post(article);
    } else if (command === "ihave") {
      response = await client.ihave(params[0], article);
    }
  } else {
    response = await client.request(command, ...params);
  }

  const { status, statusText, headers: articleHeaders } = response;

  const headers = new Headers(articleHeaders);
  headers.append("content-type", "text/plain;charset=utf-8");
  headers.append("X-Content-Type-Options", "nosniff");

  // Stores selected group or article to cookie for retrieval later.
  switch (status) {
    case 211: // GROUP and LISTGROUP
      setCookie(headers, {
        name: "group",
        value: params[0],
        path: "/",
      });
      break;
    case 220: // ARTICLE
    case 221: // HEAD
    case 222: // BODY
    case 223: { // LAST, NEXT, STAT
      const [, n, _messageId] = statusText.match(/([\d]+)\s(<[\x21-\x7E]+>)/) ||
        [];
      setCookie(headers, {
        name: "article",
        value: n,
        path: "/",
      });
      break;
    }
  }

  const responseInit = {
    // NNTP can have status below 200, but HTTP can't, so we normalize.
    status: status < 200 ? 200 : status,
    statusText,
    headers,
  };

  const { searchParams } = new URL(request.url);
  // Responds with just the body if `head` or `include` flag is not requested.
  if (!searchParams.has("head") && !searchParams.has("include")) {
    return new Response(response.body, responseInit);
  }

  let body = "";

  articleHeaders.forEach((value: string, name: string) => {
    body += `${name}: ${value}\r\n`;
  });

  if (searchParams.has("include")) {
    // If `body` has content, we have some articleHeaders.
    if (body) {
      body += "\r\n";
    }

    body += await response.text();
  }

  // // Prepends with response code and response text.
  body = `${status} ${statusText}` + (body ? `\r\n${body}` : "");

  return new Response(body, responseInit);
}


//#region Server
if (import.meta.main) {
  await serve(
    router(
      {
        "/": () => new Response("Hello NNTP"),
        "/favicon.ico": () => new Response(null, { status: 404 }),
        "/:command/:args*": handle,
        "/:command/": handle,
      },
    ),
    {
      port: Number(PORT),
    },
  );
}
//#endregion
