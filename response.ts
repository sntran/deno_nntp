/// <reference no-default-lib="true"/>
/// <reference lib="deno.ns" />
/// <reference lib="deno.worker" />

import { BufReader } from "./deps.ts";
import { MultiLineResponseCodes, TERMINATION, CR, LF, TERMINATING_LINE } from "./model.ts";

function isTerminatingLine(line: Uint8Array) {
  return line.every((value, index) => value === TERMINATING_LINE[index]);
}

function hasBody(status: number, statusText: string): boolean {
  // The client MUST only use the status indicator itself to determine
  // the nature of the response, as is whether the code is single-line
  // or multi-line.
  if (MultiLineResponseCodes.includes(status)) return true;

  // Note that, for historical reasons, the 211 response code is  an
  // exception to this in that the response may be single-line or multi-
  // line depending on the command (GROUP or LISTGROUP) that generated it.
  if (status === 211) {
    // Here we don't know the command that was sent, so we cheat and check
    // the statusText instead for either the word "list" or "follow".

    // @FIXME Better way to handle 211.
    // The server MAY add any text after the response code or last argument,
    // as appropriate, and the client MUST NOT make decisions based on this text.
    return /list|follow/i.test(statusText);
  }

  return false;
}

const RESPONSE_REGEX = /(?<status>[1-5][0-9][0-9])(?:\s+(?<statusText>.*))?/u;
// Each header line consists of a header name, a colon, a space, the header
// content, and a CRLF, in that order. The name consists of one or more
// printable US-ASCII characters other than colon and, for the purposes of this
// specification, is not case sensitive.
// The content MUST NOT contain CRLF; it MAY be empty.
const HEADER_REGEX = /^(?<name>[\x21-\x39\x3B-\x7E]+):\s(?<value>[\x21-\xFF\s]*)/ui;

async function parseStatus(reader: Deno.Reader): Promise<{ status: number, statusText: string }> {
  const bufReader = BufReader.create(reader);
  const responseLine: string = await bufReader.readString("\n") || "";
  // Each response MUST begin with a three-digit status indicator.
  const match = responseLine.match(RESPONSE_REGEX);
  const groups = (match || {}).groups as { status?: string, statusText?: string };
  return {
    status: Number(groups.status || ""),
    statusText: groups.statusText || "",
  };
}

// An article consists of two parts: the headers and the body.  They are
// separated by a single empty line, or in other words by two consecutive
// CRLF pairs (if there is more than one empty line, the second and
// subsequent ones are part of the body).

// The headers of an article consist of one or more header lines.  Each
// header line consists of a header name, a colon, a space, the header
// content, and a CRLF, in that order.  The name consists of one or more
// printable US-ASCII characters other than colon and, for the purposes
// of this specification, is not case sensitive.  There MAY be more than
// one header line with the same name.  The content MUST NOT contain
// CRLF; it MAY be empty.
async function parseHeaders(reader: Deno.Reader, headers: Headers = new Headers()): Promise<Headers> {
  const bufReader = BufReader.create(reader);

  // Checks the next 2 bytes to see if we can escape early.
  const next = await bufReader.peek(2);
  if (!next) return headers; // Nothing else
  if (next[0] === TERMINATION) return headers; // End of article.
  if (next[0] === CR && next[1] === LF) { // CLRF pair.
    // Swallows that empty line.
    await bufReader.readSlice(LF);
    return headers;
  }

  // The next line should be a header line.
  const buffer = await bufReader.readSlice(LF);
  const line = new TextDecoder().decode(buffer!);
  const { groups } = line.match(HEADER_REGEX) || {};
  if (!groups) return headers;

  // Appends to our `Headers`.
  headers.append(groups.name, groups.value);
  // Recursively parses the next header.
  return parseHeaders(bufReader, headers);
}

class NNTPResponse extends Response {
  static async from(reader: Deno.Reader): Promise<Response> {
    const bufReader = BufReader.create(reader);
    const { status, statusText } = await parseStatus(bufReader);
    const headers = new Headers();
    // Parses headers if the response is generated from ARTICLE OR HEAD.
    if (status === 220 || status === 221) {
      await parseHeaders(bufReader, headers);
    }

    return new NNTPResponse(bufReader, {
      status,
      statusText,
      headers,
    });
  }

  constructor(body?: Deno.Reader | ReadableStream | null, init: ResponseInit = {}) {
    const status = Number(init.status || "");
    const statusText = init.statusText || "";

    if (!(body instanceof ReadableStream)) {
      const bufReader = BufReader.create(body as Deno.Reader);
      body = null;
      if (status !== 221 && hasBody(status, statusText)) {
        // A multi-line data block is used in certain commands and responses.
        //
        // In a multi-line response, the block immediately follows the CRLF
        // at the end of the initial line of the response.
        body = new ReadableStream({
          async pull(controller) {
            // The block consists of a sequence of zero or more "lines", each
            // being a stream of octets ending with a CRLF pair. Apart from
            // those line endings, the stream MUST NOT include the octets NUL,
            // LF, or CR.
            const line = await bufReader.readSlice(LF) || new Uint8Array();

            // The lines of the block MUST be followed by a terminating line
            // consisting of a single termination octet followed by a CRLF pair
            // in the normal way.
            // ...
            // Likewise, the terminating line ("." CRLF or %x2E.0D.0A) MUST NOT
            // be considered part of the multi-line block; i.e., the recipient
            // MUST ensure that any line beginning with the termination octet
            // followed immediately by a CRLF pair is disregarded.
            if (isTerminatingLine(line)) {
              controller.close();
            }
            // If any line of the data block begins with the "termination octet"
            // ("." or %x2E), that line MUST be "dot-stuffed" by prepending an
            // additional termination octet to that line of the block.
            //
            // When a multi-line block is interpreted, the "dot-stuffing" MUST
            // be undone; i.e., the recipient MUST ensure that, in any line
            // beginning with the termination octet followed by octets other
            // than a CRLF pair, that initial termination octet is disregarded.
            else if (line[0] === TERMINATION && line[1] === TERMINATION) {
              controller.enqueue(line.subarray(1).slice());
            }
            else {
              controller.enqueue(line.slice());
            }
          }
        });
      }
    }

    super(body, {
      ...init,
      // We can't use status < 200 with initial `Response`, so we use 200...
      status: status < 200 ? 200 : status,
    });

    // ... and override the `status` getter to return actual response code.
    Object.defineProperty(this, "status", {
      get() { return status; },
    });
  }
}

export { NNTPResponse as Response }
