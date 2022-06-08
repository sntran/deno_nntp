#!/usr/bin/env -S deno run --allow-net --allow-env

/**
 * Usage:
 *
 * ```
 * $ cli.ts capabilities
 * # Fetches the body of an article and redirects to a file.
 * $ cli.ts body <msg-id> > article.txt
 * # Posts an article with custom headers and body from a file.
 * $ cli.ts post \
 *    --header "Message-ID: <abc@def>" \
 *    -H "From: poster@example.com" \
 *    --body article.txt
 * # Sends an article with body from `stdin`.
 * $ cat article.txt | cli.ts ihave <msg-id> \
 *    --header "Message-ID: <abc@def>" \
 *    -H "From: poster@example.com" \
 *    -B -
 */

import { parse  } from "https://deno.land/std@0.142.0/flags/mod.ts";
import { readerFromStreamReader, copy } from "../deps.ts";

import { Client, Article, Response } from "../mod.ts";

const flags = parse(Deno.args, {
  string: [
    "hostname", "port",
    "username", "password",
    "header", "body",
    "log-level",
  ],
  boolean: "ssl",
  collect: [
    "header",
  ],
  alias: {
    "hostname": ["host", "h"],
    "port": "P",
    "ssl":"S",
    "username": ["user", "u"],
    "password": ["pass", "p"],
    "header": "H",
    "body": "B",
    "log-level": ["logLevel", "l"],
  },
  default: {
    hostname: Deno.env.get("NNTP_HOSTNAME"),
    port: Deno.env.get("NNTP_PORT"),
    user: Deno.env.get("NNTP_USER"),
    pass: Deno.env.get("NNTP_PASS"),
  },
});

const {
  hostname, port, ssl,
  username, password,
  header,
  body: bodyInput,
  logLevel = "WARNING",
  _: [ command = "HELP", ...args ]
} = flags;

const client = await Client.connect({
  hostname,
  port: Number(port),
  ssl,
  logLevel,
});

if (username) {
  await client.authinfo(username, password);
}

let block: Deno.FsFile | undefined;
if (bodyInput === "-") {
  block = Deno.stdin as Deno.FsFile;
} else if (typeof bodyInput === "string") {
  block = await Deno.open(bodyInput, {
    read: true,
    write: false,
  });
}

let response: Response;
if (block) {
  const headers = [].concat(header).reduce((headers, header: string) => {
    const [key, value] = header.split(/:\s?/);
    headers.append(key, value);
    return headers;
  }, new Headers());

  const article = new Article({
    headers,
    body: block.readable,
  });

  if (command === "post") {
    response = await client.post(article);
  } else if (command === "ihave") {
    response = await client.ihave(args[0] as string, article);
  }
} else {
  response = await client.request(command as string, ...args);
}

const encoder = new TextEncoder();
const { status, statusText, headers, body } = response!;
// Logs information to `stderr`.
await Deno.stderr.write(encoder.encode(`${ status } ${statusText}`));

const lines: string[] = [];
headers.forEach((value: string, key: string) => {
  lines.push(`${ key }: ${ value }\r\n`);
});
await Deno.stdout.write(encoder.encode(lines.join("")));

if (body) {
  if (lines.length) {
    // Separates the headers and body with an empty line.
    Deno.stdout.write(encoder.encode("\r\n"));
  }
  const reader = readerFromStreamReader(body.getReader());
  await copy(reader, Deno.stdout);
}
