/// <reference no-default-lib="true"/>
/// <reference lib="deno.ns" />
/// <reference lib="deno.worker" />

import { BufReader } from "https://deno.land/std@0.134.0/io/mod.ts";
import * as log from "https://deno.land/std@0.134.0/log/mod.ts";

export const enum Command {
  ARTICLE = "ARTICLE", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.2.1
  BODY = "BODY", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.2.3
  CAPABILITIES = "CAPABILITIES", // https://datatracker.ietf.org/doc/html/rfc3977#section-5.2
  DATE = "DATE", // https://datatracker.ietf.org/doc/html/rfc3977#section-7.1
  GROUP = "GROUP", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.1.1
  HDR = "HDR", // https://datatracker.ietf.org/doc/html/rfc3977#section-8.5
  HEAD = "HEAD", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.2.2
  HELP = "HELP", // https://datatracker.ietf.org/doc/html/rfc3977#section-7.2
  IHAVE = "IHAVE", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.3.2
  LAST = "LAST", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.1.3
  LIST = "LIST", // https://datatracker.ietf.org/doc/html/rfc3977#section-7.6.1
  LISTGROUP = "LISTGROUP", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.1.2
  "MODE READER" = "MODE READER", // https://datatracker.ietf.org/doc/html/rfc3977#section=5.3
  NEWGROUPS = "NEWGROUPS", // https://datatracker.ietf.org/doc/html/rfc3977#section-7.3
  NEWNEWS = "NEWNEWS", // https://datatracker.ietf.org/doc/html/rfc3977#section-7.4
  NEXT = "NEXT", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.1.4
  OVER = "OVER", // https://datatracker.ietf.org/doc/html/rfc3977#section-8.3
  POST = "POST", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.3.1
  QUIT = "QUIT", // https://datatracker.ietf.org/doc/html/rfc3977#section-5.4
  STAT = "STAT", // https://datatracker.ietf.org/doc/html/rfc3977#section-6.2.4
  // Extensions
  "AUTHINFO USER" = "AUTHINFO USER", // https://datatracker.ietf.org/doc/html/rfc4643#section-2.3
  "AUTHINFO PASS" = "AUTHINFO PASS",
  "AUTHINFO SASL" = "AUTHINFO SASL", // https://datatracker.ietf.org/doc/html/rfc4643#section-2.4
}

const MultiLiners = [
  Command.ARTICLE,
  Command.BODY,
  Command.CAPABILITIES,
  Command.HDR,
  Command.HEAD,
  Command.HELP,
  Command.LIST,
  Command.LISTGROUP,
  Command.NEWGROUPS,
  Command.NEWNEWS,
  Command.OVER,
];

function isMultiLine(command: Command): command is Command {
  return MultiLiners.includes(command as Command);
}

type parameter = string | number;

export interface ConnectOptions extends Deno.ConnectOptions {
  logLevel?: keyof typeof log.LogLevels,
}

export class Client {
  #options:ConnectOptions;
  #connection?: Deno.TcpConn;
  #logger?: log.Logger;

  static async connect(options?: ConnectOptions) {
    const client = new Client(options);
    await client.connect();
    return client;
  }

  constructor(options?: ConnectOptions) {
    options = {
      port: 119,
      logLevel: "INFO",
      ...options,
    }
    this.#options = options;
  }

  /**
   * Connects to NNTP server and returns its greeting.
   */
  async connect(): Promise<Response> {
    await log.setup({
      handlers: {
        console: new log.handlers.ConsoleHandler(this.#options.logLevel!),
      },
      loggers: {
        nntp: {
          level: this.#options.logLevel,
          handlers: ["console"],
        },
      },
    });

    this.#logger = log.getLogger("nntp");
    this.#connection = await Deno.connect(this.#options);
    // When the connection is established, the NNTP server host
    // MUST send a greeting.
    return this.getResponse();
  }

  async getResponse(command?: Command): Promise<Response> {
    const bufReader = new BufReader(this.#connection!);
    const responseLine: string = await bufReader.readString("\n") || "";

    // Each response MUST begin with a three-digit status indicator.
    const [_, statusCode, statusText = ""] = responseLine.match(/([1-5][0-9][0-9])\s(.*)/) || [];
    let status = parseInt(statusCode);
    this.#logger!.debug(`[S] ${ responseLine }`);

    const headers = {
      "content-type": "text/plain;charset=utf-8",
    };

    let body = "";
    if (isMultiLine(command!)) {
      let ended = false;
      while (!ended) {
        const line = await bufReader.readString("\n") || "";
        body += line;
        if (line.indexOf(".\r\n") === (line.length - 3)) {
          ended = true;
        }
      }
    }

    if (status < 200) {
      // We can't use 101 status for HTTP.
      status = 200;
    }

    return new Response(body, {
      status,
      statusText,
      headers,
    });
  }

  /**
   * Sends a NNTP command to the server.
   *
   * Commands in NNTP MUST consist of a keyword, which MAY be followed by one.
   * or more arguments. A CRLF pair MUST terminate all commands.  Multiple
   * commands MUST NOT be on the same line.
   *
   * Command lines MUST NOT exceed 512 octets, which includes the terminating
   * CRLF pair.  The arguments MUST NOT exceed 497 octets.
   */
  async request(command: Command, ...args: parameter[]): Promise<Response> {
    command = command.toUpperCase() as Command;
    const line = [command, ...args].join(" ");
    this.#logger!.debug(`[C] ${ line }`)
    const request = new TextEncoder().encode(
      `${ line }\r\n`,
    );
    const _bytesWritten = await this.#connection?.write(request);
    return this.getResponse(command);
  }

  close() {
    this.#connection?.close();
  }
}
