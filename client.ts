import { BufReader } from "https://deno.land/std@0.134.0/io/mod.ts";

export enum Command {
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
};

const MultiLiners = [
  Command.HELP,
  Command.CAPABILITIES,
  Command.LISTGROUP,
  Command.LIST,
  Command.ARTICLE,
  Command.HEAD,
  Command.BODY,
  Command.OVER,
  Command.HDR,
  Command.NEWNEWS,
  Command.NEWGROUPS,
] as const;

export class Client {
  #options?: ConnectOptions;
  #connection?: TcpConn;
  
  constructor(options: ConnectOptions) {
    this.#options = options;
  }

  /**
   * Connects to NNTP server and returns its greeting.
   */
  async connect() {
    this.#connection = await Deno.connect(this.#options);
    // When the connection is established, the NNTP server host
    // MUST send a greeting.
    return this.getResponse();
  }

  async getResponse(command: CommandName): Response {
    const bufReader = new BufReader(this.#connection);
    const responseLine: string = await bufReader.readString("\n");

    // Each response MUST begin with a three-digit status indicator.
    let [_, statusCode, statusText = ""] = responseLine.match(/([1-5][0-9][0-9])\s(.*)/) || [];
    let status = parseInt(statusCode);
    console.info(`[S] ${ responseLine }`);

    const headers = {
      "content-type": "text/plain;charset=utf-8",
    };

    let body = "";
    if (MultiLiners.includes(command)) {
      let ended = false;
      while (!ended) {
        const line = await bufReader.readString("\n");
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
  async request(command: Command, args: string[] = []): Response {
    command = command.toUpperCase();
    const line = [command, ...args].join(" ");
    console.info(`[C] ${ line }`)
    const request = new TextEncoder().encode(
      `${ line }\r\n`,
    );
    const _bytesWritten = await this.#connection.write(request);
    return this.getResponse(command);
  }
}