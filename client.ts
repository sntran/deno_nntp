/// <reference no-default-lib="true"/>
/// <reference lib="deno.ns" />
/// <reference lib="deno.worker" />

import { StringReader, readerFromStreamReader, copy, log } from "./deps.ts";

import { Command, Response, Article } from "./mod.ts";

type parameter = string | number | undefined;
type wildmat = string;

export interface ConnectOptions extends Deno.ConnectOptions {
  logLevel?: keyof typeof log.LogLevels,
}

export interface NNTPClient  {
  capabilities(keyword?: string): Promise<Response>
  modeReader(): Promise<Response>
  quit(): Promise<Response>
  group(group?: string): Promise<Response>
  listgroup(group?: string, range?: string): Promise<Response>
  last(): Promise<Response>
  next(): Promise<Response>
  article(number?: number): Promise<Response>
  article(messageId?: string): Promise<Response>
  head(number?: number): Promise<Response>
  head(messageId?: string): Promise<Response>
  body(number?: number): Promise<Response>
  body(messageId?: string): Promise<Response>
  stat(number?: number): Promise<Response>
  stat(messageId?: string): Promise<Response>
  post(article: Article): Promise<Response>
  ihave(messageId: string, article: Article): Promise<Response>
  date(): Promise<Response>
  help(): Promise<Response>
  newgroups(date: string, time: string, isGMT?: boolean): Promise<Response>
  newnews(wildmat: wildmat, date: string, time: string, isGMT?: boolean): Promise<Response>
  list(keyword?: string, arg?: wildmat|parameter): Promise<Response>
  over(messageId?: string): Promise<Response>
  over(range?: string): Promise<Response>
  over(arg?: string): Promise<Response>
  hdr(field: string, messageId?: string): Promise<Response>
  hdr(field: string, range?: string): Promise<Response>
  hdr(field: string, arg?: string): Promise<Response>
  authinfo(username: string, password?: string): Promise<Response>
}

export class Client implements NNTPClient {
  #options: ConnectOptions;
  #connection?: Deno.TcpConn;
  #logger?: log.Logger;

  /**
   * Creates a Client and connects to NNTP server and returns its greeting.
   *
   * ## Examples
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client: Client = await Client.connect({ hostname: "127.0.0.1", port: 119 });
   * ```
   */
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
   *
   * ## Examples
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = new Client({ hostname: "127.0.0.1", port: 119 });
   * const response = await client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * console.assert(response.ok);
   * ```
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

    log.info(`[S] ${ status } ${ statusText }`);
    for (const header of headers.entries()) {
      log.info(`[S] ${ header[0] }: ${ header[1].replace(/\r?\n|\r/, "") }`);
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
   *
   * ## Examples
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = new Client();
   * await client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.request("GROUP", "misc.test")
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * console.assert(response.status === 211)
   * ```
   */
  async request(command: string, ...args: parameter[]): Promise<Response>;
  async request(command: Command, ...args: parameter[]): Promise<Response>;
  async request(stream: ReadableStream, ...args: parameter[]): Promise<Response>;
  async request(input: Command | string | ReadableStream, ...args: parameter[]): Promise<Response> {
    let reader: Deno.Reader;
    if (typeof input === "string") {
      input = input.toUpperCase() as Command;
      const line = [input, ...args.map(normalize)].join(" ");
      this.#logger!.info(`[C] ${ line }`);
      reader = new StringReader(`${ line }\r\n`);
    } else {
      reader = readerFromStreamReader(input.getReader());
    }

    const writer = this.#connection!;
    const _bytesWritten = await copy(reader, writer);
    return this.#getResponse();
  }

  close() {
    this.#connection?.close();
  }

  //#region 5. Session Administration Commands

  /**
   * The CAPABILITIES command allows a client to determine the
   * capabilities of the server at any given time.
   *
   * This command MAY be issued at any time; the server MUST NOT require
   * it to be issued in order to make use of any capability.  The response
   * generated by this command MAY change during a session because of
   * other state information (which, in turn, may be changed by the
   * effects of other commands or by external events).  An NNTP client is
   * only able to get the current and correct information concerning
   * available capabilities at any point during a session by issuing a
   * CAPABILITIES command at that point of that session and processing the
   * response.
   *
   * The capability list is returned as a multi-line data block following
   * the 101 response code. Each capability is described by a separate
   * capability line. The server MUST NOT list the same capability twice
   * in the response, even with different arguments.  Except that the
   * VERSION capability MUST be the first line, the order in which the
   * capability lines appears is not significant; the server need not even
   * consistently return the same order.
   *
   * While some capabilities are likely to be always available or never
   * available, others (notably extensions) will appear and disappear
   * depending on server state changes within the session or on external
   * events between sessions.  An NNTP client MAY cache the results of
   * this command, but MUST NOT rely on the correctness of any cached
   * results, whether from earlier in this session or from a previous
   * session, MUST cope gracefully with the cached status being out of
   * date, and SHOULD (if caching results) provide a way to force the
   * cached information to be refreshed.  Furthermore, a client MUST NOT
   * use cached results in relation to security, privacy, and
   * authentication extensions.
   *
   * The keyword argument is not used by this specification.  It is
   * provided so that extensions or revisions to this specification can
   * include extra features for this command without requiring the
   * CAPABILITIES command to be used twice (once to determine if the extra
   * features are available, and a second time to make use of them).  If
   * the server does not recognise the argument (and it is a keyword), it
   * MUST respond with the 101 response code as if the argument had been
   * omitted.  If an argument is provided that the server does recognise,
   * it MAY use the 101 response code or MAY use some other response code
   * (which will be defined in the specification of that feature).  If the
   * argument is not a keyword, the 501 generic response code MUST be
   * returned.  The server MUST NOT generate any other response code to
   * the CAPABILITIES command.
   *
   * ## Examples
   *
   * Example of a minimal response (a read-only server):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.capabilities();
   * // [C] CAPABILITIES
   * // [S] 101 Capability list:
   * // [S] VERSION 2
   * // [S] READER
   * // [S] LIST ACTIVE NEWSGROUPS
   * // [S] .
   * ```
   */
  capabilities(keyword?: string): Promise<Response> {
    return this.request(Command.CAPABILITIES, keyword);
  }

  /**
   * The MODE READER command instructs a mode-switching server to switch
   * modes.
   *
   * If the server is mode-switching, it switches from its transit mode to
   * its reader mode, indicating this by changing the capability list
   * accordingly.  It MUST then return a 200 or 201 response with the same
   * meaning as for the initial greeting (as described in Section 5.1.1).
   * Note that the response need not be the same as that presented during
   * the initial greeting.  The client MUST NOT issue MODE READER more
   * than once in a session or after any security or privacy commands are
   * issued.  When the MODE READER command is issued, the server MAY reset
   * its state to that immediately after the initial connection before
   * switching mode.

   * If the server is not mode-switching, then the following apply:

   * - If it advertises the READER capability, it MUST return a 200 or
   *   201 response with the same meaning as for the initial greeting; in
   *   this case, the command MUST NOT affect the server state in any
   *   way.
   * - If it does not advertise the READER capability, it MUST return a
   *   502 response and then immediately close the connection.
   *
   *  ## Examples
   *
   * Example of use of the MODE READER command on a transit-only server
   * (which therefore does not providing reading facilities):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * let response = await client.capabilities();
   * // [C] CAPABILITIES
   * // [S] 101 Capability list:
   * // [S] VERSION 2
   * // [S] IHAVE
   * // [S] .
   * response = await client.modeReader();
   * // [C] MODE READER
   * // [S] 502 Transit service only
   * ```
   */
  modeReader(): Promise<Response> {
    return this.request(Command["MODE READER"]);
  }

  /**
   * The client uses the QUIT command to terminate the session.
   *
   * The server MUST acknowledge the QUIT command and then close the
   * connection to the client.  This is the preferred method for a client
   * to indicate that it has finished all of its transactions with the
   * NNTP server.
   *
   * ## Examples
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.quit();
   * // [C] QUIT
   * // [S] 205 closing connection
   * ```
   */
  async quit(): Promise<Response> {
    const response = await this.request(Command.QUIT);
    this.#connection?.close();
    return response;
  }

  //#endregion 5. Session Administration Commands

  //#region 6. Article Posting and Retrieval

  //#region 6.1 Group and Article Selection

  /**
   * The GROUP command selects a newsgroup as the currently selected
   * newsgroup and returns summary information about it.
   *
   * The required argument is the name of the newsgroup to be selected
   * (e.g., "news.software.nntp").  A list of valid newsgroups may be
   * obtained by using the LIST ACTIVE command.
   *
   * The successful selection response will return the article numbers of
   * the first and last articles in the group at the moment of selection
   * (these numbers are referred to as the "reported low water mark" and
   * the "reported high water mark") and an estimate of the number of
   * articles in the group currently available.
   *
   * If the group is not empty, the estimate MUST be at least the actual
   * number of articles available and MUST be no greater than one more
   * than the difference between the reported low and high water marks.
   * (Some implementations will actually count the number of articles
   * currently stored.  Others will just subtract the low water mark from
   * the high water mark and add one to get an estimate.)
   *
   * If the group is empty, one of the following three situations will
   * occur.  Clients MUST accept all three cases; servers MUST NOT
   * represent an empty group in any other way.
   *
   * - The high water mark will be one less than the low water mark, and
   *   the estimated article count will be zero.  Servers SHOULD use this
   *   method to show an empty group.  This is the only time that the
   *   high water mark can be less than the low water mark.
   * - All three numbers will be zero.
   * - The high water mark is greater than or equal to the low water
   *   mark.  The estimated article count might be zero or non-zero; if
   *   it is non-zero, the same requirements apply as for a non-empty
   *   group.
   *
   * The set of articles in a group may change after the GROUP command is
   * carried out:
   *
   * - Articles may be removed from the group.
   * - Articles may be reinstated in the group with the same article
   *   number, but those articles MUST have numbers no less than the
   *   reported low water mark (note that this is a reinstatement of the
   *   previous article, not a new article reusing the number).
   * - New articles may be added with article numbers greater than the
   *   reported high water mark.  (If an article that was the one with
   *   the highest number has been removed and the high water mark has
   *   been adjusted accordingly, the next new article will not have the
   *   number one greater than the reported high water mark.)
   *
   * Except when the group is empty and all three numbers are zero,
   * whenever a subsequent GROUP command for the same newsgroup is issued,
   * either by the same client or a different client, the reported low
   * water mark in the response MUST be no less than that in any previous
   * response for that newsgroup in this session, and it SHOULD be no less
   * than that in any previous response for that newsgroup ever sent to
   * any client.  Any failure to meet the latter condition SHOULD be
   * transient only.  The client may make use of the low water mark to
   * remove all remembered information about articles with lower numbers,
   * as these will never recur.  This includes the situation when the high
   * water mark is one less than the low water mark.  No similar
   * assumption can be made about the high water mark, as this can
   * decrease if an article is removed and then increase again if it is
   * reinstated or if new articles arrive.
   *
   * When a valid group is selected by means of this command, the
   * currently selected newsgroup MUST be set to that group, and the
   * current article number MUST be set to the first article in the group
   * (this applies even if the group is already the currently selected
   * newsgroup).  If an empty newsgroup is selected, the current article
   * number is made invalid.  If an invalid group is specified, the
   * currently selected newsgroup and current article number MUST NOT be
   * changed.
   *
   * The GROUP or LISTGROUP command (see Section 6.1.2) MUST be used by a
   * client, and a successful response received, before any other command
   * is used that depends on the value of the currently selected newsgroup
   * or current article number.
   *
   * If the group specified is not available on the server, a 411 response
   * MUST be returned.
   *
   * ## Examples
   *
   * Example for a group known to the server:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * ```
   *
   * Example for a group unknown to the server:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.is.sob.bradner.or.barber");
   * // [C] GROUP example.is.sob.bradner.or.barber
   * // [S] 411 example.is.sob.bradner.or.barber is unknown
   * ```
   *
   * Example of an empty group using the preferred response:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.currently.empty.newsgroup");
   * // [C] GROUP example.currently.empty.newsgroup
   * // [S] 211 0 4000 3999 example.currently.empty.newsgroup
   * ```
   *
   * Example of an empty group using an alternative response:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.currently.empty.newsgroup");
   * // [C] GROUP example.currently.empty.newsgroup
   * // [S] 211 0 0 0 example.currently.empty.newsgroup
   * ```
   *
   * Example of an empty group using a different alternative response:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.currently.empty.newsgroup");
   * // [C] GROUP example.currently.empty.newsgroup
   * // [S] 211 0 4000 4321 example.currently.empty.newsgroup
   * ```
   *
   * Example reselecting the currently selected newsgroup:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 234 567 misc.test
   * await client.stat(444);
   * // [C] STAT 444
   * // [S] 223 444 <123456@example.net> retrieved
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 234 567 misc.test
   * await client.stat();
   * // [C] STAT
   * // [S] 223 234 <different@example.net> retrieved
   * ```
   */
  group(group: string): Promise<Response> {
    return this.request(Command.GROUP, group);
  }

  /**
   * The LISTGROUP command selects a newsgroup in the same manner as the
   * GROUP command (see Section 6.1.1) but also provides a list of article
   * numbers in the newsgroup.  If no group is specified, the currently
   * selected newsgroup is used.
   *
   * On success, a list of article numbers is returned as a multi-line
   * data block following the 211 response code (the arguments on the
   * initial response line are the same as for the GROUP command).  The
   * list contains one number per line and is in numerical order.  It
   * lists precisely those articles that exist in the group at the moment
   * of selection (therefore, an empty group produces an empty list).  If
   * the optional range argument is specified, only articles within the
   * range are included in the list (therefore, the list MAY be empty even
   * if the group is not).
   *
   * The range argument may be any of the following:
   *
   * - An article number.
   * - An article number followed by a dash to indicate all following.
   * - An article number followed by a dash followed by another article
   *    number.
   *
   * In the last case, if the second number is less than the first number,
   * then the range contains no articles.  Omitting the range is
   * equivalent to the range 1- being specified.
   *
   * If the group specified is not available on the server, a 411 response
   * MUST be returned.  If no group is specified and the currently
   * selected newsgroup is invalid, a 412 response MUST be returned.
   *
   * Except that the group argument is optional, that a range argument can
   * be specified, and that a multi-line data block follows the 211
   * response code, the LISTGROUP command is identical to the GROUP
   * command.  In particular, when successful, the command sets the
   * current article number to the first article in the group, if any,
   * even if this is not within the range specified by the second
   * argument.
   *
   * Note that the range argument is a new feature in this specification
   * and servers that do not support CAPABILITIES (and therefore do not
   * conform to this specification) are unlikely to support it.
   *
   * ## Examples
   *
   * Example of LISTGROUP being used to select a group:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.listgroup("misc.test");
   * // [C] LISTGROUP misc.test
   * // [S] 211 2000 3000234 3002322 misc.test list follows
   * // [S] 3000234
   * // [S] 3000237
   * // [S] 3000238
   * // [S] 3000239
   * // [S] 3002322
   * // [S] .
   * ```
   *
   * Example of LISTGROUP on an empty group:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.listgroup("example.empty.newsgroup");
   * // [C] LISTGROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup list follows
   * // [S] .
   * ```
   *
   * Example of LISTGROUP on a valid, currently selected newsgroup:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 2000 3000234 3002322 misc.test
   * const response = await client.listgroup();
   * // [C] LISTGROUP
   * // [S] 211 2000 3000234 3002322 misc.test list follows
   * // [S] 3000234
   * // [S] 3000237
   * // [S] 3000238
   * // [S] 3000239
   * // [S] 3002322
   * // [S] .
   * ```
   *
   * Example of LISTGROUP with a range:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.listgroup("misc.test", "3000238-3000248");
   * // [C] LISTGROUP misc.test 3000238-3000248
   * // [S] 211 2000 3000234 3002322 misc.test list follows
   * // [S] 3000238
   * // [S] 3000239
   * // [S] .
   * ```
   *
   * Example of LISTGROUP with an empty range:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.listgroup("misc.test", "12345678-");
   * // [C] LISTGROUP misc.test 12345678-
   * // [S] 211 2000 3000234 3002322 misc.test list follows
   * // [S] .
   * ```
   *
   * Example of LISTGROUP with an invalid range:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * const response = await client.listgroup("misc.test", "9999-111");
   * // [C] LISTGROUP misc.test 9999-111
   * // [S] 211 2000 3000234 3002322 misc.test list follows
   * // [S] .
   * ```
   */
  listgroup(group?: string, range?: string): Promise<Response> {
    return this.request(Command.LISTGROUP, group, range);
  }

  /**
   * If the currently selected newsgroup is valid, the current article
   * number MUST be set to the previous article in that newsgroup (that
   * is, the highest existing article number less than the current article
   * number).  If successful, a response indicating the new current
   * article number and the message-id of that article MUST be returned.
   * No article text is sent in response to this command.
   *
   * There MAY be no previous article in the group, although the current
   * article number is not the reported low water mark.  There MUST NOT be
   * a previous article when the current article number is the reported
   * low water mark.
   *
   * Because articles can be removed and added, the results of multiple
   * LAST and NEXT commands MAY not be consistent over the life of a
   * particular NNTP session.
   *
   * If the current article number is already the first article of the
   * newsgroup, a 422 response MUST be returned.  If the current article
   * number is invalid, a 420 response MUST be returned.  If the currently
   * selected newsgroup is invalid, a 412 response MUST be returned.  In
   * all three cases, the currently selected newsgroup and current article
   * number MUST NOT be altered.
   *
   * ## Examples
   *
   * Example of a successful article retrieval using LAST:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.next();
   * // [C] NEXT
   * // [S] 223 3000237 <668929@example.org> retrieved
   * await client.last();
   * // [C] LAST
   * // [S] 223 3000234 <45223423@example.com> retrieved
   * ```
   *
   * Example of an attempt to retrieve an article without having selected
   * a group (via the GROUP command) first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.last();
   * // [C] LAST
   * // [S] 412 no newsgroup selected
   * ```
   *
   * Example of an attempt to retrieve an article using the LAST command
   * when the current article number is that of the first article in the
   * group:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.last();
   * // [C] LAST
   * // [S] 422 No previous article to retrieve
   * ```
   *
   * Example of an attempt to retrieve an article using the LAST command
   * when the currently selected newsgroup is empty:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.last();
   * // [C] LAST
   * // [S] 420 No current article selected
   */
  last(): Promise<Response> {
    return this.request(Command.LAST);
  }

  /**
   * If the currently selected newsgroup is valid, the current article
   * number MUST be set to the next article in that newsgroup (that is,
   * the lowest existing article number greater than the current article
   * number).  If successful, a response indicating the new current
   * article number and the message-id of that article MUST be returned.
   * No article text is sent in response to this command.
   *
   * If the current article number is already the last article of the
   * newsgroup, a 421 response MUST be returned.  In all other aspects
   * (apart, of course, from the lack of 422 response), this command is
   * identical to the LAST command (Section 6.1.3).
   *
   * ## Examples
   *
   * Example of a successful article retrieval using NEXT:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.next();
   * // [C] NEXT
   * // [S] 223 3000237 <668929@example.org> retrieved
   * ```
   *
   * Example of an attempt to retrieve an article without having selected
   * a group (via the GROUP command) first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.next();
   * // [C] NEXT
   * // [S] 412 no newsgroup selected
   * ```
   *
   * Example of an attempt to retrieve an article using the NEXT command
   * when the current article number is that of the last article in the
   * group:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.next();
   * // [C] NEXT
   * // [S] 420 No current article selected
   * ```
   */
  next(): Promise<Response> {
    return this.request(Command.NEXT);
  }

  //#endregion 6.1 Group and Article Selection

  //#region 6.2 Retrieval of Articles and Article Sections

  /**
   * The ARTICLE command selects an article according to the arguments and
   * presents the entire article (that is, the headers, an empty line, and
   * the body, in that order) to the client.  The command has three forms.
   *
   * In the first form, a message-id is specified, and the server presents
   * the article with that message-id.  In this case, the server MUST NOT
   * alter the currently selected newsgroup or current article number.
   * This is both to facilitate the presentation of articles that may be
   * referenced within another article being read, and because of the
   * semantic difficulties of determining the proper sequence and
   * membership of an article that may have been cross-posted to more than
   * one newsgroup.
   *
   * In the response, the article number MUST be replaced with zero,
   * unless there is a currently selected newsgroup and the article is
   * present in that group, in which case the server MAY use the article's
   * number in that group.  (The server is not required to determine
   * whether the article is in the currently selected newsgroup or, if so,
   * what article number it has; the client MUST always be prepared for
   * zero to be specified.)  The server MUST NOT provide an article number
   * unless use of that number in a second ARTICLE command immediately
   * following this one would return the same article.  Even if the server
   * chooses to return article numbers in these circumstances, it need not
   * do so consistently; it MAY return zero to any such command (also see
   * the STAT examples, Section 6.2.4.3).
   *
   * In the second form, an article number is specified.  If there is an
   * article with that number in the currently selected newsgroup, the
   * server MUST set the current article number to that number.
   *
   * In the third form, the article indicated by the current article
   * number in the currently selected newsgroup is used.
   *
   * Note that a previously valid article number MAY become invalid if the
   * article has been removed.  A previously invalid article number MAY
   * become valid if the article has been reinstated, but this article
   * number MUST be no less than the reported low water mark for that
   * group.
   *
   * The server MUST NOT change the currently selected newsgroup as a
   * result of this command.  The server MUST NOT change the current
   * article number except when an article number argument was provided
   * and the article exists; in particular, it MUST NOT change it
   * following an unsuccessful response.
   *
   * Since the message-id is unique for each article, it may be used by a
   * client to skip duplicate displays of articles that have been posted
   * more than once, or to more than one newsgroup.
   *
   * The article is returned as a multi-line data block following the 220
   * response code.
   *
   * If the argument is a message-id and no such article exists, a 430
   * response MUST be returned.  If the argument is a number or is omitted
   * and the currently selected newsgroup is invalid, a 412 response MUST
   * be returned.  If the argument is a number and that article does not
   * exist in the currently selected newsgroup, a 423 response MUST be
   * returned.  If the argument is omitted and the current article number
   * is invalid, a 420 response MUST be returned.
   *
   * ## Examples
   *
   * Example of a successful retrieval of an article (explicitly not using
   * an article number):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.article();
   * // [C] ARTICLE
   * // [S] 220 3000234 <45223423@example.com>
   * // [S] Path: pathost!demo!whitehouse!not-for-mail
   * // [S] From: "Demo User" <nobody@example.net>
   * // [S] Newsgroups: misc.test
   * // [S] Subject: I am just a test article
   * // [S] Date: 6 Oct 1998 04:38:40 -0500
   * // [S] Organization: An Example Net, Uncertain, Texas
   * // [S] Message-ID: <45223423@example.com>
   * // [S]
   * // [S] This is just a test article.
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of an article by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.article("<45223423@example.com>");
   * // [C] ARTICLE <45223423@example.com>
   * // [S] 220 0 <45223423@example.com>
   * // [S] Path: pathost!demo!whitehouse!not-for-mail
   * // [S] From: "Demo User" <nobody@example.net>
   * // [S] Newsgroups: misc.test
   * // [S] Subject: I am just a test article
   * // [S] Date: 6 Oct 1998 04:38:40 -0500
   * // [S] Organization: An Example Net, Uncertain, Texas
   * // [S] Message-ID: <45223423@example.com>
   * // [S]
   * // [S] This is just a test article.
   * // [S] .
   * ```
   *
   * Example of an unsuccessful retrieval of an article by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.article("<i.am.not.there@example.com>");
   * // [C] ARTICLE <i.am.not.there@example.com>
   * // [S] 430 No Such Article Found
   * ```
   *
   * Example of an unsuccessful retrieval of an article by number:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 news.groups
   * await client.article(300256);
   * // [C] ARTICLE 300256
   * // [S] 423 No article with that number
   * ```
   *
   * Example of an unsuccessful retrieval of an article by number because
   * no newsgroup was selected first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.article(300256);
   * // [C] ARTICLE 300256
   * // [S] 412 No newsgroup selected
   * ```
   *
   * Example of an attempt to retrieve an article when the currently
   * selected newsgroup is empty:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.article();
   * // [C] ARTICLE
   * // [S] 420 No current article selected
   * ```
   */
  article(messageId?: string): Promise<Response>;
  article(number?: number): Promise<Response>;
  article(arg?: parameter): Promise<Response> {
    return this.request(Command.ARTICLE, arg);
  }

  /**
   * The HEAD command behaves identically to the ARTICLE command except
   * that, if the article exists, the response code is 221 instead of 220
   * and only the headers are presented (the empty line separating the
   * headers and body MUST NOT be included).
   *
   * ## Examples
   *
   * Example of a successful retrieval of the headers of an article
   * (explicitly not using an article number):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.head();
   * // [C] HEAD
   * // [S] 221 3000234 <45223423@example.com>
   * // [S] Path: pathost!demo!whitehouse!not-for-mail
   * // [S] From: "Demo User" <nobody@example.net>
   * // [S] Newsgroups: misc.test
   * // [S] Subject: I am just a test article
   * // [S] Date: 6 Oct 1998 04:38:40 -0500
   * // [S] Organization: An Example Net, Uncertain, Texas
   * // [S] Message-ID: <45223423@example.com>
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of the headers of an article by
   * message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.head("<45223423@example.com>");
   * // [C] HEAD <45223423@example.com>
   * // [S] 221 0 <45223423@example.com>
   * // [S] Path: pathost!demo!whitehouse!not-for-mail
   * // [S] From: "Demo User" <nobody@example.net>
   * // [S] Newsgroups: misc.test
   * // [S] Subject: I am just a test article
   * // [S] Date: 6 Oct 1998 04:38:40 -0500
   * // [S] Organization: An Example Net, Uncertain, Texas
   * // [S] Message-ID: <45223423@example.com>
   * // [S] .
   * ```
   *
   * Example of an unsuccessful retrieval of the headers of an article by
   * message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.head("<i.am.not.there@example.com>");
   * // [C] HEAD <i.am.not.there@example.com>
   * // [S] 430 No Such Article Found
   * ```
   *
   * Example of an unsuccessful retrieval of the headers of an article by
   * number:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.head(300256);
   * // [C] HEAD 300256
   * // [S] 423 No article with that number
   * ```
   *
   * Example of an unsuccessful retrieval of the headers of an article by
   * number because no newsgroup was selected first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.head(300256);
   * // [C] HEAD 300256
   * // [S] 412 No newsgroup selected
   * ```
   *
   * Example of an attempt to retrieve the headers of an article when the
   * currently selected newsgroup is empty:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.head();
   * // [C] HEAD
   * // [S] 420 No current article selected
   * ```
   */
  head(messageId?: string): Promise<Response>;
  head(number?: number): Promise<Response>;
  head(arg?: parameter): Promise<Response> {
    return this.request(Command.HEAD, arg);
  }

  /**
   * The BODY command behaves identically to the ARTICLE command except
   * that, if the article exists, the response code is 222 instead of 220
   * and only the body is presented (the empty line separating the headers
   * and body MUST NOT be included).
   *
   * ## Examples
   *
   * Example of a successful retrieval of the body of an article
   * (explicitly not using an article number):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.body();
   * // [C] BODY
   * // [S] 222 3000234 <45223423@example.com>
   * // [S] This is just a test article.
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of the body of an article by
   * message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.body("<45223423@example.com>");
   * // [C] BODY <45223423@example.com>
   * // [S] 222 0 <45223423@example.com>
   * // [S] This is just a test article.
   * // [S] .
   * ```
   *
   * Example of an unsuccessful retrieval of the body of an article by
   * message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.body("<i.am.not.there@example.com>");
   * // [C] BODY <i.am.not.there@example.com>
   * // [S] 430 No Such Article Found
   * ```
   *
   * Example of an unsuccessful retrieval of the body of an article by
   * number:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.body(300256);
   * // [C] BODY 300256
   * // [S] 423 No article with that number
   * ```
   *
   * Example of an unsuccessful retrieval of the body of an article by
   * number because no newsgroup was selected first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.body(300256);
   * // [C] BODY 300256
   * // [S] 412 No newsgroup selected
   * ```
   *
   * Example of an attempt to retrieve the body of an article when the
   * currently selected newsgroup is empty:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.body();
   * // [C] BODY
   * // [S] 420 No current article selected
   * ```
   */
  body(messageId?: string): Promise<Response>;
  body(number?: number): Promise<Response>;
  body(arg?: parameter): Promise<Response> {
    return this.request(Command.BODY, arg);
  }

  /**
   * The STAT command behaves identically to the ARTICLE command except
   * that, if the article exists, it is NOT presented to the client and
   * the response code is 223 instead of 220.  Note that the response is
   * NOT multi-line.
   *
   * This command allows the client to determine whether an article exists
   * and, in the second and third forms, what its message-id is, without
   * having to process an arbitrary amount of text.
   *
   * ## Examples
   *
   * Example of STAT on an existing article (explicitly not using an
   * article number):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.stat();
   * // [C] STAT
   * // [S] 223 3000234 <45223423@example.com>
   * ```
   *
   * Example of STAT on an existing article by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.stat("<45223423@example.com>");
   * // [C] STAT <45223423@example.com>
   * // [S] 223 0 <45223423@example.com>
   * ```
   *
   * Example of STAT on an article not on the server by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.stat("<i.am.not.there@example.com>");
   * // [C] STAT <i.am.not.there@example.com>
   * // [S] 430 No Such Article Found
   * ```
   *
   * Example of STAT on an article not in the server by number:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.stat(300256)
   * // [C] STAT 300256
   * // [S] 423 No article with that number
   * ```
   *
   * Example of STAT on an article by number when no newsgroup was
   * selected first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.stat(300256);
   * // [C] STAT 300256
   * // [S] 412 No newsgroup selected
   * ```
   *
   * Example of STAT on an article when the currently selected newsgroup
   * is empty:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.stat();
   * // [C] STAT
   * // [S] 420 No current article selected
   * ```
   *
   * Example of STAT by message-id on a server that sometimes reports the
   * actual article number:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.stat();
   * // [C] STAT
   * // [S] 223 3000234 <45223423@example.com>
   * await client.stat("<45223423@example.com>");
   * // [C] STAT <45223423@example.com>
   * // [S] 223 0 <45223423@example.com>
   * await client.stat("<45223423@example.com>");
   * // [C] STAT <45223423@example.com>
   * // [S] 223 3000234 <45223423@example.com>
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.stat("<45223423@example.com>");
   * // [C] STAT <45223423@example.com>
   * // [S] 223 0 <45223423@example.com>
   * await client.group("alt.crossposts");
   * // [C] GROUP alt.crossposts
   * // [S] 211 9999 111111 222222 alt.crossposts
   * await client.stat("<45223423@example.com>");
   * // [C] STAT <45223423@example.com>
   * // [S] 223 123456 <45223423@example.com>
   * await client.stat();
   * // [C] STAT
   * // [S] 223 111111 <23894720@example.com>
   * ```
   */
  stat(messageId?: string): Promise<Response>;
  stat(number?: number): Promise<Response>;
  stat(arg?: parameter): Promise<Response> {
    return this.request(Command.STAT, arg);
  }

  //#endregion 6.2. Group and Article Selection

  //#region 6.3. Article Posting

  /**
   * If posting is allowed, a 340 response MUST be returned to indicate
   * that the article to be posted should be sent.  If posting is
   * prohibited for some installation-dependent reason, a 440 response
   * MUST be returned.
   *
   * If posting is permitted, the article MUST be in the format specified
   * in Section 3.6 and MUST be sent by the client to the server as a
   * multi-line data block (see Section 3.1.1).  Thus a single dot (".")
   * on a line indicates the end of the text, and lines starting with a
   * dot in the original text have that dot doubled during transmission.
   *
   * Following the presentation of the termination sequence by the client,
   * the server MUST return a response indicating success or failure of
   * the article transfer.  Note that response codes 340 and 440 are used
   * in direct response to the POST command while 240 and 441 are returned
   * after the article is sent.
   *
   * A response of 240 SHOULD indicate that, barring unforeseen server
   * errors, the posted article will be made available on the server
   * and/or transferred to other servers, as appropriate, possibly
   * following further processing.  In other words, articles not wanted by
   * the server SHOULD be rejected with a 441 response, rather than being
   * accepted and then discarded silently.  However, the client SHOULD NOT
   * assume that the article has been successfully transferred unless it
   * receives an affirmative response from the server and SHOULD NOT
   * assume that it is being made available to other clients without
   * explicitly checking (for example, using the STAT command).
   *
   * If the session is interrupted before the response is received, it is
   * possible that an affirmative response was sent but has been lost.
   * Therefore, in any subsequent session, the client SHOULD either check
   * whether the article was successfully posted before resending or
   * ensure that the server will allocate the same message-id to the new
   * attempt (see Appendix A.2).  The latter approach is preferred since
   * the article might not have been made available for reading yet (for
   * example, it may have to go through a moderation process).
   *
   * ## Examples
   *
   * Example of a successful posting:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.post({
   *   headers: {
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Organization": "An Example Net",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] POST
   * // [S] 340 Input article; end with <CR-LF>.<CR-LF>
   * // [C] From: "Demo User" <nobody@example.net>
   * // [C] Newsgroups: misc.test
   * // [C] Subject: I am just a test article
   * // [C] Organization: An Example Net
   * // [C]
   * // [C] This is just a test article.
   * // [C] .
   * // [S] 240 Article received OK
   * ```
   *
   * Example of an unsuccessful posting:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.post({
   *   headers: {
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Organization": "An Example Net",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] POST
   * // [S] 340 Input article; end with <CR-LF>.<CR-LF>
   * // [C] From: "Demo User" <nobody@example.net>
   * // [C] Newsgroups: misc.test
   * // [C] Subject: I am just a test article
   * // [C] Organization: An Example Net
   * // [C]
   * // [C] This is just a test article.
   * // [C] .
   * // [S] 441 Posting failed
   * ```
   *
   * Example of an attempt to post when posting is not allowed:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect({
   *   hostname: "readonly.news.server",
   *   port: 119,
   * });
   * // [S] 201 NNTP Service Ready, posting prohibited
   * await client.post();
   * // [C] POST
   * // [S] 440 Posting not permitted
   * ```
   */
  async post(article?: Article): Promise<Response> {
    const response = await this.request(Command.POST);

    // If no article is provided, it means the user will send it later.
    if (!article) {
      return response;
    }

    // Posting not permitted.
    if (response.status === 440) {
      return response;
    }

    return this.request(article.stream());
  }

  /**
   * The IHAVE command informs the server that the client has an article
   * with the specified message-id.  If the server desires a copy of that
   * article, a 335 response MUST be returned, instructing the client to
   * send the entire article.  If the server does not want the article
   * (if, for example, the server already has a copy of it), a 435
   * response MUST be returned, indicating that the article is not wanted.
   * Finally, if the article isn't wanted immediately but the client
   * should retry later if possible (if, for example, another client is in
   * the process of sending the same article to the server), a 436
   * response MUST be returned.
   *
   * If transmission of the article is requested, the client MUST send the
   * entire article, including headers and body, to the server as a
   * multi-line data block (see Section 3.1.1).  Thus, a single dot (".")
   * on a line indicates the end of the text, and lines starting with a
   * dot in the original text have that dot doubled during transmission.
   * The server MUST return a 235 response, indicating that the article
   * was successfully transferred; a 436 response, indicating that the
   * transfer failed but should be tried again later; or a 437 response,
   * indicating that the article was rejected.
   *
   * This function differs from the POST command in that it is intended
   * for use in transferring already-posted articles between hosts.  It
   * SHOULD NOT be used when the client is a personal news-reading
   * program, since use of this command indicates that the article has
   * already been posted at another site and is simply being forwarded
   * from another host.  However, despite this, the server MAY elect not
   * to post or forward the article if, after further examination of the
   * article, it deems it inappropriate to do so.  Reasons for such
   * subsequent rejection of an article may include problems such as
   * inappropriate newsgroups or distributions, disc space limitations,
   * article lengths, garbled headers, and the like.  These are typically
   * restrictions enforced by the server host's news software and not
   * necessarily by the NNTP server itself.
   *
   * The client SHOULD NOT assume that the article has been successfully
   * transferred unless it receives an affirmative response from the
   * server.  A lack of response (such as a dropped network connection or
   * a network timeout) SHOULD be treated the same as a 436 response.
   *
   * Because some news server software may not immediately be able to
   * determine whether an article is suitable for posting or forwarding,
   * an NNTP server MAY acknowledge the successful transfer of the article
   * (with a 235 response) but later silently discard it.
   *
   * ## Examples
   *
   * Example of successfully sending an article to another site:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.ihave("<i.am.an.article.you.will.want@example.com>", {
   *   headers: {
   *     "Path": "pathost!demo!somewhere!not-for-mail",
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Date": "6 Oct 1998 04:38:40 -0500",
   *     "Organization": "An Example Com, San Jose, CA",
   *     "Message-ID": "<i.am.an.article.you.will.want@example.com>",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] IHAVE <i.am.an.article.you.will.want@example.com>
   * // [S] 335 Send it; end with <CR-LF>.<CR-LF>
   * // [C] Path: pathost!demo!somewhere!not-for-mail
   * // [C] From: "Demo User" <nobody@example.com>
   * // [C] Newsgroups: misc.test
   * // [C] Subject: I am just a test article
   * // [C] Date: 6 Oct 1998 04:38:40 -0500
   * // [C] Organization: An Example Com, San Jose, CA
   * // [C] Message-ID: <i.am.an.article.you.will.want@example.com>
   * // [C]
   * // [C] This is just a test article.
   * // [C] .
   * // [S] 235 Article transferred OK
   * ```
   *
   * Example of sending an article to another site that rejects it.  Note
   * that the message-id in the IHAVE command is not the same as the one
   * in the article headers; while this is bad practice and SHOULD NOT be
   * done, it is not forbidden.
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.ihave("<i.am.an.article.you.will.want@example.com>", {
   *   headers: {
   *     "Path": "pathost!demo!somewhere!not-for-mail",
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Date": "6 Oct 1998 04:38:40 -0500",
   *     "Organization": "An Example Com, San Jose, CA",
   *     "Message-ID": "<i.am.an.article.you.have@example.com>",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] IHAVE <i.am.an.article.you.will.want@example.com>
   * // [S] 335 Send it; end with <CR-LF>.<CR-LF>
   * // [C] Path: pathost!demo!somewhere!not-for-mail
   * // [C] From: "Demo User" <nobody@example.com>
   * // [C] Newsgroups: misc.test
   * // [C] Subject: I am just a test article
   * // [C] Date: 6 Oct 1998 04:38:40 -0500
   * // [C] Organization: An Example Com, San Jose, CA
   * // [C] Message-ID: <i.am.an.article.you.have@example.com>
   * // [C]
   * // [C] This is just a test article.
   * // [C] .
   * // [S] 437 Article rejected; don't send again
   * ```
   *
   * Example of sending an article to another site where the transfer
   * fails:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.ihave("<i.am.an.article.you.will.want@example.com>", {
   *   headers: {
   *     "Path": "pathost!demo!somewhere!not-for-mail",
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Date": "6 Oct 1998 04:38:40 -0500",
   *     "Organization": "An Example Com, San Jose, CA",
   *     "Message-ID": "<i.am.an.article.you.will.want@example.com>",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] IHAVE <i.am.an.article.you.will.want@example.com>
   * // [S] 335 Send it; end with <CR-LF>.<CR-LF>
   * // [C] Path: pathost!demo!somewhere!not-for-mail
   * // [C] From: "Demo User" <nobody@example.com>
   * // [C] Newsgroups: misc.test
   * // [C] Subject: I am just a test article
   * // [C] Date: 6 Oct 1998 04:38:40 -0500
   * // [C] Organization: An Example Com, San Jose, CA
   * // [C] Message-ID: <i.am.an.article.you.will.want@example.com>
   * // [C]
   * // [C] This is just a test article.
   * // [C] .
   * // [S] 436 Transfer failed
   * ```
   *
   * Example of sending an article to a site that already has it:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.ihave("<i.am.an.article.you.have@example.com>", {
   *   headers: {
   *     "Path": "pathost!demo!somewhere!not-for-mail",
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Date": "6 Oct 1998 04:38:40 -0500",
   *     "Organization": "An Example Com, San Jose, CA",
   *     "Message-ID": "<i.am.an.article.you.have@example.com>",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] IHAVE <i.am.an.article.you.have@example.com>
   * // [S] 435 Duplicate
   * ```
   *
   * Example of sending an article to a site that requests that the
   * article be tried again later:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.ihave("<i.am.an.article.you.defer@example.com>", {
   *   headers: {
   *     "Path": "pathost!demo!somewhere!not-for-mail",
   *     "From": `"Demo User" <nobody@example.net>`,
   *     "Newsgroups": "misc.test",
   *     "Subject": "I am just a test article",
   *     "Date": "6 Oct 1998 04:38:40 -0500",
   *     "Organization": "An Example Com, San Jose, CA",
   *     "Message-ID": "<i.am.an.article.you.defer@example.com>",
   *   },
   *   body: "This is just a test article.",
   * });
   * // [C] IHAVE <i.am.an.article.you.defer@example.com>
   * // [S] 436 Retry later
   * ```
   *
   * @returns
   */
  async ihave(messageId: string, article?: Article): Promise<Response> {
    const response = await this.request(Command.IHAVE, messageId);

    // If no article is provided, it means the user will send it later.
    if (!article) {
      return response;
    }

    // No go, bail out.
    if (response.status !== 335) {
      return response;
    }

    return this.request(article.stream());
  }

  //#endregion 6.3. Article Posting

  //#endregion 6. Article Posting and Retrieval

  //#region 7. Information Commands

  /**
   * This command exists to help clients find out the current Coordinated
   * Universal Time [TF.686-1] from the server's perspective.  This
   * command SHOULD NOT be used as a substitute for NTP [RFC1305] but to
   * provide information that might be useful when using the NEWNEWS
   * command (see Section 7.4).
   *
   * The DATE command MUST return a timestamp from the same clock as is
   * used for determining article arrival and group creation times (see
   * Section 6).  This clock SHOULD be monotonic, and adjustments SHOULD
   * be made by running it fast or slow compared to "real" time rather
   * than by making sudden jumps.  A system providing NNTP service SHOULD
   * keep the system clock as accurate as possible, either with NTP or by
   * some other method.
   *
   * The server MUST return a 111 response specifying the date and time on
   * the server in the form yyyymmddhhmmss.  This date and time is in
   * Coordinated Universal Time.
   *
   * ## Examples
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.date();
   * // [C] DATE
   * // [S] 111 19990623135624
   * ```
   *
   * @returns Current UTC date and time on server in `yyyymmddhhmmss` format.
   */
  date(): Promise<Response> {
    return this.request(Command.DATE);
  }

  /**
   * This command provides a short summary of the commands that are
   * understood by this implementation of the server.  The help text will
   * be presented as a multi-line data block following the 100 response
   * code.
   *
   * This text is not guaranteed to be in any particular format (but must
   * be UTF-8) and MUST NOT be used by clients as a replacement for the
   * CAPABILITIES command described in Section 5.2.
   *
   * ## Examples
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.help();
   * // [C] HELP
   * // [S] 100 Help text follows
   * // [S] This is some help text.  There is no specific
   * // [S] formatting requirement for this test, though
   * // [S] it is customary for it to list the valid commands
   * // [S] and give a brief definition of what they do.
   * // [S] .
   * ```
   *
   * @returns Help text (multi-line)
   */
  help(): Promise<Response> {
    return this.request(Command.HELP);
  }

  /**
   * This command returns a list of newsgroups created on the server since
   * the specified date and time.  The results are in the same format as
   * the LIST ACTIVE command (see Section 7.6.3).  However, they MAY
   * include groups not available on the server (and so not returned by
   * LIST ACTIVE) and MAY omit groups for which the creation date is not
   * available.
   *
   * The date is specified as 6 or 8 digits in the format [xx]yymmdd,
   * where xx is the first two digits of the year (19-99), yy is the last
   * two digits of the year (00-99), mm is the month (01-12), and dd is
   * the day of the month (01-31).  Clients SHOULD specify all four digits
   * of the year.  If the first two digits of the year are not specified
   * (this is supported only for backward compatibility), the year is to
   * be taken from the current century if yy is smaller than or equal to
   * the current year, and the previous century otherwise.
   *
   * The time is specified as 6 digits in the format hhmmss, where hh is
   * the hours in the 24-hour clock (00-23), mm is the minutes (00-59),
   * and ss is the seconds (00-60, to allow for leap seconds).  The token
   * "GMT" specifies that the date and time are given in Coordinated
   * Universal Time [TF.686-1]; if it is omitted, then the date and time
   * are specified in the server's local timezone.  Note that there is no
   * way of using the protocol specified in this document to establish the
   * server's local timezone.
   *
   * Note that an empty list is a possible valid response and indicates
   * that there are no new newsgroups since that date-time.
   *
   * Clients SHOULD make all queries using Coordinated Universal Time
   * (i.e., by including the "GMT" argument) when possible.
   *
   * ## Examples
   *
   * Example where there are new groups:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.newsgroup("19990624", "000000", true;
   * // [C] NEWGROUPS 19990624 000000 GMT
   * // [S] 231 list of new newsgroups follows
   * // [S] alt.rfc-writers.recovery 4 1 y
   * // [S] tx.natives.recovery 89 56 y
   * // [S] .
   * ```
   *
   * Example where there are no new groups:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.newsgroup("19990624", "000000", true);
   * // [C] NEWGROUPS 19990624 000000 GMT
   * // [S] 231 list of new newsgroups follows
   * // [S] .
   * ```
   *
   * @param date Date in yymmdd or yyyymmdd format
   * @param time Time in hhmmss format
   * @param isGMT Whether date and time are given in GMT.
   * @returns List of new newsgroups (multi-line)
   */
  newgroups(date: string, time: string, isGMT?: boolean): Promise<Response> {
    return this.request(Command.NEWGROUPS, date, time, isGMT ? "GMT": "");
  }

  /**
   * This command returns a list of message-ids of articles posted or
   * received on the server, in the newsgroups whose names match the
   * wildmat, since the specified date and time.  One message-id is sent
   * on each line; the order of the response has no specific significance
   * and may vary from response to response in the same session.  A
   * message-id MAY appear more than once; if it does, it has the same
   * meaning as if it appeared only once.
   *
   * Date and time are in the same format as the NEWGROUPS command (see
   * Section 7.3).
   *
   * Note that an empty list is a possible valid response and indicates
   * that there is currently no new news in the relevant groups.
   *
   * Clients SHOULD make all queries in Coordinated Universal Time (i.e.,
   * by using the "GMT" argument) when possible.
   *
   * ## Examples
   *
   * Example where there are new groups:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.newnews("news.*,sci.*", "19990624", "000000", true;
   * // [C] NEWNEWS news.*,sci.* 19990624 000000 GMT
   * // [S] 230 list of new articles by message-id follows
   * // [S] <i.am.a.new.article@example.com>
   * // [S] <i.am.another.new.article@example.com>
   * // [S] .
   * ```
   *
   * Example where there are no new groups:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.newnews("alt.*", "19990624", "000000", true);
   * // [C] NEWNEWS alt.* 19990624 000000 GMT
   * // [S] 230 list of new articles by message-id follows
   * // [S] .
   * ```
   *
   * @param wildmat
   * @param date Date in yymmdd or yyyymmdd format
   * @param time Time in hhmmss format
   * @param isGMT Whether date and time are given in GMT.
   * @returns List of new articles (multi-line)
   */
  newnews(wildmat: wildmat, date: string, time: string, isGMT?: boolean): Promise<Response> {
    return this.request(Command.NEWNEWS, wildmat, date, time, isGMT ? "GMT": "");
  }

  /**
   * The LIST command allows the server to provide blocks of information
   * to the client.  This information may be global or may be related to
   * newsgroups; in the latter case, the information may be returned
   * either for all groups or only for those matching a wildmat.  Each
   * block of information is represented by a different keyword.  The
   * command returns the specific information identified by the keyword.
   *
   * If the information is available, it is returned as a multi-line data
   * block following the 215 response code.  The format of the information
   * depends on the keyword.  The information MAY be affected by the
   * additional argument, but the format MUST NOT be.
   *
   * If the information is based on newsgroups and the optional wildmat
   * argument is specified, the response is limited to only the groups (if
   * any) whose names match the wildmat and for which the information is
   * available.
   *
   * Note that an empty list is a possible valid response; for a
   * newsgroup-based keyword, it indicates that there are no groups
   * meeting the above criteria.
   *
   * If the keyword is not recognised, or if an argument is specified and
   * the keyword does not expect one, a 501 response code MUST BE
   * returned.  If the keyword is recognised but the server does not
   * maintain the information, a 503 response code MUST BE returned.
   *
   * The LIST command MUST NOT change the visible state of the server in
   * any way; that is, the behaviour of subsequent commands MUST NOT be
   * affected by whether the LIST command was issued.  For example, it
   * MUST NOT make groups available that otherwise would not have been.
   *
   * ## Standard LIST Keywords
   *
   * RFC3977 specification defines the following LIST keywords:
   *
   * | Keyword      | Definition     | Status                                           |
   * |--------------|---------------|--------------------------------------------------|
   * | ACTIVE       | Section 7.6.3 | Mandatory if the READER capability is advertised |
   * |              |               |                                                  |
   * | ACTIVE.TIMES | Section 7.6.4 | Optional                                         |
   * |              |               |                                                  |
   * | DISTRIB.PATS | Section 7.6.5 | Optional                                         |
   * |              |               |                                                  |
   * | HEADERS      | Section 8.6   | Mandatory if the HDR capability is advertised    |
   * |              |               |                                                  |
   * | NEWSGROUPS   | Section 7.6.6 | Mandatory if the READER capability is advertised |
   * |              |               |                                                  |
   * | OVERVIEW.FMT | Section 8.4   | Mandatory if the OVER capability is advertised   |
   *
   * Where one of these LIST keywords is supported by a server, it MUST
   * have the meaning given in the relevant sub-section.
   *
   * ## Examples
   *
   * Example of LIST with the ACTIVE keyword:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.list("ACTIVE");
   * // [C] LIST ACTIVE
   * // [S] 215 list of newsgroups follows
   * // [S] misc.test 3002322 3000234 y
   * // [S] comp.risks 442001 441099 m
   * // [S] alt.rfc-writers.recovery 4 1 y
   * // [S] tx.natives.recovery 89 56 y
   * // [S] tx.natives.recovery.d 11 9 n
   * // [S] .
   * ```
   *
   * Example of LIST with no keyword:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.list();
   * // [C] LIST
   * // [S] 215 list of newsgroups follows
   * // [S] misc.test 3002322 3000234 y
   * // [S] comp.risks 442001 441099 m
   * // [S] alt.rfc-writers.recovery 4 1 y
   * // [S] tx.natives.recovery 89 56 y
   * // [S] tx.natives.recovery.d 11 9 n
   * // [S] .
   * ```
   *
   * The output is identical to that of the previous example.
   *
   * Example of LIST on a newsgroup-based keyword with and without
   * wildmat:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.list("ACTIVE.TIMES");
   * // [C] LIST ACTIVE.TIMES
   * // [S] 215 information follows
   * // [S] misc.test 930445408 <creatme@isc.org>
   * // [S] alt.rfc-writers.recovery 930562309 <m@example.com>
   * // [S] tx.natives.recovery 930678923 <sob@academ.com>
   * // [S] .
   * await client.list("ACTIVE.TIMES", "tx.*");
   * // [C] LIST ACTIVE.TIMES tx.*
   * // [S] 215 information follows
   * // [S] tx.natives.recovery 930678923 <sob@academ.com>
   * // [S] .
   * ```
   *
   * Example of LIST returning an error where the keyword is recognized
   * but the software does not maintain this information:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.capabilities();
   * // [C] CAPABILITIES
   * // [S] 101 Capability list:
   * // [S] VERSION 2
   * // [S] READER
   * // [S] LIST ACTIVE NEWSGROUPS ACTIVE.TIMES XTRA.DATA
   * // [S] .
   * await client.list("XTRA.DATA");
   * // [C] LIST XTRA.DATA
   * // [S] 503 Data item not stored
   * ```
   *
   * Example of LIST where the keyword is not recognised:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.capabilities();
   * // [C] CAPABILITIES
   * // [S] 101 Capability list:
   * // [S] VERSION 2
   * // [S] READER
   * // [S] LIST ACTIVE NEWSGROUPS ACTIVE.TIMES XTRA.DATA
   * // [S] .
   * await client.list("DISTRIB.PATS");
   * // [C] LIST DISTRIB.PATS
   * // [S] 501 Syntax Error
   * ```
   *
   * @param keyword Information requested. Default to `ACTIVE`.
   * @param arg Specific to keyword, or a wildmat for groups of interest.
   * @returns Requested information (multi-line).
   */
  list(keyword?: string, arg?: wildmat|parameter): Promise<Response> {
    return this.request(Command.LIST, keyword, arg);
  }

  //#endregion 7. Information Commands

  //#region 8. Article Field Access Commands

  /**
   * The OVER command returns the contents of all the fields in the
   * database for an article specified by message-id, or from a specified
   * article or range of articles in the currently selected newsgroup.
   *
   * The message-id argument indicates a specific article.  The range
   * argument may be any of the following:
   *
   * -  An article number.
   * -  An article number followed by a dash to indicate all following.
   * -  An article number followed by a dash followed by another article
   *    number.
   *
   * If neither is specified, the current article number is used.
   *
   * Support for the first (message-id) form is optional.  If it is
   * supported, the OVER capability line MUST include the argument
   * "MSGID".  Otherwise, the capability line MUST NOT include this
   * argument, and the OVER command MUST return the generic response code
   * 503 when this form is used.
   *
   * If the information is available, it is returned as a multi-line data
   * block following the 224 response code and contains one line per
   * article, sorted in numerical order of article number.  (Note that
   * unless the argument is a range including a dash, there will be
   * exactly one line in the data block.)  Each line consists of a number
   * of fields separated by a TAB.  A field may be empty (in which case
   * there will be two adjacent TABs), and a sequence of trailing TABs may
   * be omitted.
   *
   * The first 8 fields MUST be the following, in order:
   *
   *     "0" or article number (see below)
   *     Subject header content
   *     From header content
   *     Date header content
   *     Message-ID header content
   *     References header content
   *     :bytes metadata item
   *     :lines metadata item
   *
   * If the article is specified by message-id (the first form of the
   * command), the article number MUST be replaced with zero, except that
   * if there is a currently selected newsgroup and the article is present
   * in that group, the server MAY use the article's number in that group.
   * (See the ARTICLE command (Section 6.2.1) and STAT examples
   * (Section 6.2.4.3) for more details.)  In the other two forms of the
   * command, the article number MUST be returned.
   *
   * Any subsequent fields are the contents of the other headers and
   * metadata held in the database.
   *
   * For the five mandatory headers, the content of each field MUST be
   * based on the content of the header (that is, with the header name and
   * following colon and space removed).  If the article does not contain
   * that header, or if the content is empty, the field MUST be empty.
   * For the two mandatory metadata items, the content of the field MUST
   * be just the value, with no other text.
   *
   * For all subsequent fields that contain headers, the content MUST be
   * the entire header line other than the trailing CRLF.  For all
   * subsequent fields that contain metadata, the field consists of the
   * metadata name, a single space, and then the value.
   *
   * For all fields, the value is processed by first removing all CRLF
   * pairs (that is, undoing any folding and removing the terminating
   * CRLF) and then replacing each TAB with a single space.  If there is
   * no such header in the article, no such metadata item, or no header or
   * item stored in the database for that article, the corresponding field
   * MUST be empty.
   *
   * Note that, after unfolding, the characters NUL, LF, and CR cannot
   * occur in the header of an article offered by a conformant server.
   * Nevertheless, servers SHOULD check for these characters and replace
   * each one by a single space (so that, for example, CR LF LF TAB will
   * become two spaces, since the CR and first LF will be removed by the
   * unfolding process).  This will encourage robustness in the face of
   * non-conforming data; it is also possible that future versions of this
   * specification could permit these characters to appear in articles.
   *
   * The server SHOULD NOT produce output for articles that no longer
   * exist.
   *
   * If the argument is a message-id and no such article exists, a 430
   * response MUST be returned.  If the argument is a range or is omitted
   * and the currently selected newsgroup is invalid, a 412 response MUST
   * be returned.  If the argument is a range and no articles in that
   * number range exist in the currently selected newsgroup, including the
   * case where the second number is less than the first one, a 423
   * response MUST be returned.  If the argument is omitted and the
   * current article number is invalid, a 420 response MUST be returned.
   *
   * ## Examples
   *
   * In the first four examples, TAB has been replaced by vertical bar and
   * some lines have been folded for readability.
   *
   * Example of a successful retrieval of overview information for an
   * article (explicitly not using an article number):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.over();
   * // [C] OVER
   * // [S] 224 Overview information follows
   * // [S] 3000234|I am just a test article|"Demo User"
   * //     <nobody@example.com>|6 Oct 1998 04:38:40 -0500|
   * //     <45223423@example.com>|<45454@example.net>|1234|
   * //     17|Xref: news.example.com misc.test:3000363
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of overview information for an
   * article by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.capabilities();
   * // [C] CAPABILITIES
   * // [S] 101 Capability list:
   * // [S] VERSION 2
   * // [S] READER
   * // [S] OVER MSGID
   * // [S] LIST ACTIVE NEWSGROUPS OVERVIEW.FMT
   * // [S] .
   * await client.over("<45223423@example.com>");
   * // [C] OVER <45223423@example.com>
   * // [S] 224 Overview information follows
   * // [S] 0|I am just a test article|"Demo User"
   * //     <nobody@example.com>|6 Oct 1998 04:38:40 -0500|
   * //     <45223423@example.com>|<45454@example.net>|1234|
   * //     17|Xref: news.example.com misc.test:3000363
   * // [S] .
   * ```
   *
   * Note that the article number has been replaced by "0".
   *
   * Example of the same commands on a system that does not implement
   * retrieval by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.capabilities();
   * // [C] CAPABILITIES
   * // [S] 101 Capability list:
   * // [S] VERSION 2
   * // [S] READER
   * // [S] OVER
   * // [S] LIST ACTIVE NEWSGROUPS OVERVIEW.FMT
   * // [S] .
   * await client.over("<45223423@example.com>");
   * // [C] OVER <45223423@example.com>
   * // [S] 503 Overview by message-id unsupported
   * ```
   *
   * Example of a successful retrieval of overview information for a range
   * of articles:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.over("3000234-3000240");
   * // [C] OVER 3000234-3000240
   * // [S] 224 Overview information follows
   * // [S] 3000234|I am just a test article|"Demo User"
   * //     <nobody@example.com>|6 Oct 1998 04:38:40 -0500|
   * //     <45223423@example.com>|<45454@example.net>|1234|
   * //     17|Xref: news.example.com misc.test:3000363
   * // [S] 3000235|Another test article|nobody@nowhere.to
   * //     (Demo User)|6 Oct 1998 04:38:45 -0500|<45223425@to.to>||
   * //     4818|37||Distribution: fi
   * // [S] 3000238|Re: I am just a test article|somebody@elsewhere.to|
   * //     7 Oct 1998 11:38:40 +1200|<kfwer3v@elsewhere.to>|
   * //     <45223423@to.to>|9234|51
   * // [S] .
   * ```
   *
   * Note the missing "References" and Xref headers in the second line,
   * the missing trailing fields in the first and last lines, and that
   * there are only results for those articles that still exist.
   *
   * Example of an unsuccessful retrieval of overview information on an
   * article by number:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.over("300256");
   * // [C] OVER 300256
   * // [S] 423 No such article in this group
   * ```
   *
   * Example of an invalid range:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.over("3000444-3000222");
   * // [C] OVER 3000444-3000222
   * // [S] 423 Empty range
   * ```
   *
   * Example of an unsuccessful retrieval of overview information by
   * number because no newsgroup was selected first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.over();
   * // [C] OVER
   * // [S] 412 No newsgroup selected
   * ```
   *
   * Example of an attempt to retrieve information when the currently
   * selected newsgroup is empty:
   *
   * ```ts
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * // [C] OVER
   * // [S] 420 No current article selected
   * ```
   *
   * @param messageId Message-id of article
   * @param range Number(s) of articles
   * @returns Overview information (multi-line)
   */
  over(messageId?: string): Promise<Response>;
  over(range?: string): Promise<Response>;
  over(arg?: string): Promise<Response> {
    return this.request(Command.OVER, arg);
  }

  /**
   * The HDR command provides access to specific fields from an article
   * specified by message-id, or from a specified article or range of
   * articles in the currently selected newsgroup.  It MAY take the
   * information directly from the articles or from the overview database.
   * In the case of headers, an implementation MAY restrict the use of
   * this command to a specific list of headers or MAY allow it to be used
   * with any header; it may behave differently when it is used with a
   * message-id argument and when it is used with a range or no argument.
   *
   * The required field argument is the name of a header with the colon
   * omitted (e.g., "subject") or the name of a metadata item including
   * the leading colon (e.g., ":bytes"), and is case insensitive.
   *
   * The message-id argument indicates a specific article.  The range
   * argument may be any of the following:
   *
   * - An article number.
   * - An article number followed by a dash to indicate all following.
   * - An article number followed by a dash followed by another article
   *   number.
   *
   * If neither is specified, the current article number is used.
   *
   * If the information is available, it is returned as a multi-line data
   * block following the 225 response code and contains one line for each
   * article in the range that exists.  (Note that unless the argument is
   * a range including a dash, there will be exactly one line in the data
   * block.)  The line consists of the article number, a space, and then
   * the contents of the field.  In the case of a header, the header name,
   * the colon, and the first space after the colon are all omitted.
   *
   * If the article is specified by message-id (the first form of the
   * command), the article number MUST be replaced with zero, except that
   * if there is a currently selected newsgroup and the article is present
   * in that group, the server MAY use the article's number in that group.
   * (See the ARTICLE command (Section 6.2.1) and STAT examples
   * (Section 6.2.4.3) for more details.)  In the other two forms of the
   * command, the article number MUST be returned.
   *
   * Header contents are modified as follows: all CRLF pairs are removed,
   * and then each TAB is replaced with a single space.  (Note that this
   * is the same transformation as is performed by the OVER command
   * (Section 8.3.2), and the same comment concerning NUL, CR, and LF
   * applies.)
   *
   * Note the distinction between headers and metadata appearing to have
   * the same meaning.  Headers are always taken unchanged from the
   * article; metadata are always calculated.  For example, a request for
   * "Lines" returns the contents of the "Lines" header of the specified
   * articles, if any, no matter whether they accurately state the number
   * of lines, while a request for ":lines" returns the line count
   * metadata, which is always the actual number of lines irrespective of
   * what any header may state.
   *
   * If the requested header is not present in the article, or if it is
   * present but empty, a line for that article is included in the output,
   * but the header content portion of the line is empty (the space after
   * the article number MAY be retained or omitted).  If the header occurs
   * in a given article more than once, only the content of the first
   * occurrence is returned by HDR.  If any article number in the provided
   * range does not exist in the group, no line for that article number is
   * included in the output.
   *
   * If the second argument is a message-id and no such article exists, a
   * 430 response MUST be returned.  If the second argument is a range or
   * is omitted and the currently selected newsgroup is invalid, a 412
   * response MUST be returned.  If the second argument is a range and no
   * articles in that number range exist in the currently selected
   * newsgroup, including the case where the second number is less than
   * the first one, a 423 response MUST be returned.  If the second
   * argument is omitted and the current article number is invalid, a 420
   * response MUST be returned.
   *
   * A server MAY only allow HDR commands for a limited set of fields; it
   * may behave differently in this respect for the first (message-id)
   * form from how it would for the other forms.  If so, it MUST respond
   * with the generic 503 response to attempts to request other fields,
   * rather than return erroneous results, such as a successful empty
   * response.
   *
   * If HDR uses the overview database and it is inconsistent for the
   * requested field, the server MAY return what results it can, or it MAY
   * respond with the generic 503 response.  In the latter case, the field
   * MUST NOT appear in the output from LIST HEADERS.
   *
   * ## Examples
   *
   * Example of a successful retrieval of subject lines from a range of
   * articles (3000235 has no Subject header, and 3000236 is missing):
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.hdr("Subject", "3000234-3000238");
   * // [C] HDR Subject 3000234-3000238
   * // [S] 225 Headers follow
   * // [S] 3000234 I am just a test article
   * // [S] 3000235
   * // [S] 3000237 Re: I am just a test article
   * // [S] 3000238 Ditto
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of line counts from a range of
   * articles:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.hdr(":lines", "3000234-3000238");
   * // [C] HDR :lines 3000234-3000238
   * // [S] 225 Headers follow
   * // [S] 3000234 42
   * // [S] 3000235 5
   * // [S] 3000237 11
   * // [S] 3000238 2378
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of the subject line from an article
   * by message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.hdr("subject" "<i.am.a.test.article@example.com>");
   * // [C] HDR subject <i.am.a.test.article@example.com>
   * // [S] 225 Header information follows
   * // [S] 0 I am just a test article
   * // [S] .
   * ```
   *
   * Example of a successful retrieval of the subject line from the
   * current article:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.hdr("subject");
   * // [C] HDR subject
   * // [S] 225 Header information follows
   * // [S] 3000234 I am just a test article
   * // [S] .
   * ```
   *
   * Example of an unsuccessful retrieval of a header from an article by
   * message-id:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * await client.hdr("subject", "<i.am.not.there@example.com>");
   * // [C] HDR subject <i.am.not.there@example.com>
   * // [S] 430 No Such Article Found
   * ```
   *
   * Example of an unsuccessful retrieval of headers from articles by
   * number because no newsgroup was selected first:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * await client.hdr("subject", "300256-");
   * // [C] HDR subject 300256-
   * // [S] 412 No newsgroup selected
   * ```
   *
   * Example of an unsuccessful retrieval of headers because the currently
   * selected newsgroup is empty:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("example.empty.newsgroup");
   * // [C] GROUP example.empty.newsgroup
   * // [S] 211 0 0 0 example.empty.newsgroup
   * await client.hdr("subject", "1-");
   * // [C] HDR subject 1-
   * // [S] 423 No articles in that range
   * ```
   *
   * Example of an unsuccessful retrieval of headers because the server
   * does not allow HDR commands for that header:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.group("misc.test");
   * // [C] GROUP misc.test
   * // [S] 211 1234 3000234 3002322 misc.test
   * await client.hdr("Content-Type" "3000234-3000238");
   * // [C] HDR Content-Type 3000234-3000238
   * // [S] 503 HDR not permitted on Content-Type
   * ```
   *
   * @param field Name of field
   * @param messageId Message-id of article
   * @param range Number(s) of articles
   * @returns Headers (multi-line)
   */
  hdr(field: string, messageId?: string): Promise<Response>;
  hdr(field: string, range?: string): Promise<Response>;
  hdr(field: string, arg?: string): Promise<Response> {
    return this.request(Command.HDR, field, arg);
  }

  //#endregion 8. Article Field Access Commands

  //#region RFC 4643 - NNTP Authentication

  /**
   * The AUTHINFO USER and AUTHINFO PASS commands are used to present
   * clear text credentials to the server.  These credentials consist of a
   * username or a username plus a password (the distinction is that a
   * password is expected to be kept secret, whereas a username is not;
   * this does not directly affect the protocol but may have an impact on
   * user interfaces).  The username is supplied through the AUTHINFO USER
   * command, and the password through the AUTHINFO PASS command.
   *
   * If the server requires only a username, it MUST NOT give a 381
   * response to AUTHINFO USER and MUST give a 482 response to AUTHINFO
   * PASS.
   *
   * If the server requires both username and password, the former MUST be
   * sent before the latter.  The server will need to cache the username
   * until the password is received; it MAY require that the password be
   * sent in the immediately next command (in other words, only caching
   * the username until the next command is sent).  The server:
   *
   * -  MUST return a 381 response to AUTHINFO USER;
   *
   * -  MUST return a 482 response to AUTHINFO PASS if there is no cached
   *    username;
   *
   * -  MUST use the argument of the most recent AUTHINFO USER for
   *    authentication; and
   *
   * -  MUST NOT return a 381 response to AUTHINFO PASS.
   *
   * The server MAY determine whether a password is needed for a given
   * username.  Thus the same server can respond with both 381 and other
   * response codes to AUTHINFO USER.
   *
   * Should the client successfully present proper credentials, the server
   * issues a 281 reply.  If the server is unable to authenticate the
   * client, it MUST reject the AUTHINFO USER/PASS command with a 481
   * reply.  If an AUTHINFO USER/PASS command fails, the client MAY
   * proceed without authentication.  Alternatively, the client MAY try
   * another authentication mechanism or present different credentials by
   * issuing another AUTHINFO command.
   *
   * The AUTHINFO PASS command permits the client to use a clear-text
   * password to authenticate.  A compliant implementation MUST NOT
   * implement this command without also implementing support for TLS
   * [NNTP-TLS].  Use of this command without an active strong encryption
   * layer is deprecated, as it exposes the user's password to all parties
   * on the network between the client and the server.  Any implementation
   * of this command SHOULD be configurable to disable it whenever a
   * strong encryption layer (such as that provided by [NNTP-TLS]) is not
   * active, and this configuration SHOULD be the default.  The server
   * will use the 483 response code to indicate that the datastream is
   * insufficiently secure for the command being attempted (see Section
   * 3.2.1 of [NNTP]).
   *
   * Note that a server MAY (but is not required to) allow white space
   * characters in usernames and passwords.  A server implementation MAY
   * blindly split command arguments at white space and therefore may not
   * preserve the exact sequence of white space characters in the username
   * or password.  Therefore, a client SHOULD scan the username and
   * password for white space and, if any is detected, warn the user of
   * the likelihood of problems.  The SASL PLAIN [PLAIN] mechanism is
   * recommended as an alternative, as it does not suffer from these
   * issues.
   *
   * Also note that historically the username is not canonicalized in any
   * way.  Servers MAY use the [SASLprep] profile of the [StringPrep]
   * algorithm to prepare usernames for comparison, but doing so may cause
   * interoperability problems with legacy implementations.  If
   * canonicalization is desired, the SASL PLAIN [PLAIN] mechanism is
   * recommended as an alternative.
   *
   * ## Examples
   *
   * Example of successful AUTHINFO USER:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.authinfo("wilma");
   * // [C] AUTHINFO USER wilma
   * // [S] 281 Authentication accepted
   * ```
   *
   * Example of successful AUTHINFO USER/PASS:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.authinfo("fred", "flintstone");
   * // [C] AUTHINFO USER fred
   * // [S] 381 Enter passphrase
   * // [C] AUTHINFO PASS flintstone
   * // [S] 281 Authentication accepted
   * ```
   *
   * Example of AUTHINFO USER/PASS requiring a security layer:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.authinfo("fred@stonecanyon.example.com");
   * // [C] AUTHINFO USER fred@stonecanyon.example.com
   * // [S] 483 Encryption or stronger authentication required
   * ```
   *
   * Example of failed AUTHINFO USER/PASS:
   *
   * ```ts
   * import { Client } from "./client.ts";
   * const client = await Client.connect();
   * // [S] 200 NNTP Service Ready, posting permitted
   * await client.authinfo("barney", "flintstone");
   * // [C] AUTHINFO USER barney
   * // [S] 381 Enter passphrase
   * // [C] AUTHINFO PASS flintstone
   * // [S] 481 Authentication failed
   * ```
   *
   * @returns 281 status if authentication accepted, 481 if rejected.
   */
  async authinfo(username: string, password?: string): Promise<Response> {
    let response = await this.request("AUTHINFO USER", username);
    if (response.status === 381) {
      response = await this.request("AUTHINFO PASS", password);
    }

    return response;
  }

  //#endregion RFC 4643 - NNTP Authentication
}

function normalize(arg: parameter = "") {
  // Wraps message-id with brackets if not already.
  if (/^[^<][^@]+@[^>]+$/.test(arg as string)) return `<${ arg}>`;
  return arg;
}
