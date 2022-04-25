// This is an example http server proxying NNTP.

/// <reference no-default-lib="true"/>
/// <reference lib="deno.ns" />
/// <reference lib="deno.worker" />
import { serve } from "https://deno.land/std@0.136.0/http/server.ts";
import { router } from "https://crux.land/router@0.0.11";
import { Client, Command } from "../mod.ts";

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
// @ts-nocheck should work with any argument.
function identity(e: any) { return e; }

// Make a TCP connection to NNTP server
const client = new Client({
  port: parseInt(NNTP_PORT),
  hostname: NNTP_HOSTNAME,
  logLevel: "DEBUG",
});

const response = await client.connect();

//#region Server
console.log(`Listening on http://localhost:${ PORT }`);
await serve(router(
  {
    "/": connect,
    "/favicon.ico": () => new Response(null, {status: 404}),
    "/login": login,
    "POST@/authinfo": async (req: Request) => authinfo(req, await req.formData()),
    "/:command/:args*": handle,
    "/:command/": handle,
  },
), {
  port: Number(PORT),
});
//#endregion

function connect(_req: Request) {
  const { status, statusText, headers } = response;

  return new Response(statusText, {
    status,
    statusText,
    headers,
  });
}

function login(req: Request) {
  const url = new URL(req.url);

  const body = `
    <form action="/authinfo" method="POST" enctype="multipart/form-data">
      <label>
        <span>Username: </span>
        <input name="USER" type="text" required />
      </label>
      <label>
        <span>Password: </span>
        <input name="PASS" type="password" autocomplete="current-password" required />
      </label>

      <input type="hidden" name="redirect_uri" value="${ url.searchParams.get("redirect_uri") || "" }" />

      <button type="submit">Login</button>
    </form>
    `;

  return new Response(body, {
    headers: {
      "content-type": "text/html;charset=utf-8",
    }
  });
}

async function authinfo(req: Request, formData: FormData, type = "USER"): Promise<Response> {
  const url = new URL(req.url);

  const value: string = formData.get(type) as string;
  let response = await client.request(`AUTHINFO ${ type }` as Command, value);
  switch (response.status) {
    case 381:
      response = await authinfo(req, formData, "PASS");
      break;
    case 481:
    case 482:
      response = Response.redirect(`${ url.origin }/login?redirect_uri=${ formData.get("redirect_uri") }`);
      break;
    default:
      response = Response.redirect(`${ formData.get("redirect_uri") }`);
      break;
  }

  return response;
}

async function handle(req: Request, _ctx: any, { command, args = "" }: Record<string, string>) {
  const url = new URL(req.url);
  const {
    headers: originalHeaders,
    status,
    statusText,
    body,
  } = await client.request(command as Command, ...args.split("/").filter(identity));

  // The NNTP server can respond to a client command with a a 480 response
  // to indicate that the client MUST authenticate and/or authorize in order
  // to use that command or access the indicated resource.
  if (status === 480) {
    return Response.redirect(`${ url.origin }/login?redirect_uri=${ url }`);
  }

  const headers = new Headers(originalHeaders);
  headers.append("content-type", "text/plain;charset=utf-8");
  headers.append("X-Content-Type-Options", "nosniff");

  // Needs to create a new `Response` here to include the special header
  // `X-Content-Type-Options: nosniff` to prevent browser from "sniffing"
  // the body content and deciding to popup for download instead.
  return new Response(body, {
    status,
    statusText,
    headers,
  });
}
