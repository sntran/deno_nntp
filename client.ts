/// <reference no-default-lib="true"/>
/// <reference lib="deno.ns" />
/// <reference lib="deno.worker" />

import { log } from "./deps.ts";

import { Command } from "./model.ts";
import { Response } from "./response.ts";

type parameter = string | number;

export interface ConnectOptions extends Deno.ConnectOptions {
  logLevel?: keyof typeof log.LogLevels,
}

export class Client {
  #options: ConnectOptions;
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
    return this.#getResponse();
  }

  async #getResponse(): Promise<Response> {
    const response: Response = await Response.from(this.#connection as Deno.Reader);
    const {
      status,
      statusText,
      headers,
    } = response;

    const log = this.#logger!;

    log.debug(`[S] ${ status } ${ statusText }`);
    for (const header of headers.entries()) {
      log.debug(`[S] ${ header[0] }: ${ header[1].replace(/\r?\n|\r/, "") }`);
    }

    // Logs body if required.
    const body = response.body?.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          log.debug(() => {
            const msg = new TextDecoder().decode(chunk).replace(/\r?\n|\r/, "");
            return `[S] ${ msg }`;
          });
          controller.enqueue(chunk);
        },
      }),
    );

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
    return this.#getResponse();
  }

  close() {
    this.#connection?.close();
  }
}
