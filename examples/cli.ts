import { parse  } from "https://deno.land/std@0.140.0/flags/mod.ts";
import { readerFromStreamReader, copy } from "https://deno.land/std@0.140.0/streams/conversion.ts";

import { Client } from "../mod.ts";

const flags = parse(Deno.args, {
  string: [
    "hostname", "port",
    "user", "pass",
  ],
  alias: {
    "hostname": ["host", "h"],
    "port": "P",
    "user": ["username", "u"],
    "pass": ["password", "p"],
  },
  default: {
    hostname: Deno.env.get("NNTP_HOSTNAME"),
    port: Deno.env.get("NNTP_PORT"),
    user: Deno.env.get("NNTP_USER"),
    pass: Deno.env.get("NNTP_PASS"),
  },
});

const {
  hostname, port,
  username, password,
  _: [ command = "HELP", ...args ]
} = flags;

const client = await Client.connect({
  hostname,
  port: Number(port),
  logLevel: "WARNING",
});

if (username) {
  await client.authinfo(username, password);
}

const { status, statusText, headers, body } = await client.request(command as string, ...args);

const encoder = new TextEncoder();
const lines = [`${ status } ${statusText}`];
headers.forEach((value, key) => {
  lines.push(`${ key }: ${ value }`);
});
Deno.stdout.write(encoder.encode(lines.join("\r\n")));

if (body) {
  Deno.stdout.write(encoder.encode("\r\n"));
  const reader = readerFromStreamReader(body.getReader());
  copy(reader, Deno.stdout);
}
