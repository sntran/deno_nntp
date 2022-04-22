/// <reference no-default-lib="true"/>
/// <reference lib="deno.ns" />
/// <reference lib="deno.worker" />

import { BufReader } from "./deps.ts";
import { MultiLineResponseCodes } from "./model.ts";

const TERMINATION = ".".charCodeAt(0);
const LF = "\n".charCodeAt(0);
const CR = "\r".charCodeAt(0);

const TERMINATING_LINE = Uint8Array.from([TERMINATION, CR, LF]);
function isTerminatingLine(line: Uint8Array) {
  return line.every((value, index) => value === TERMINATING_LINE[index]);
}

const RESPONSE_REGEX = /(?<status>[1-5][0-9][0-9])\s+(?<statusText>.*)/u;

function hasBody({ status, statusText }: { status: number, statusText: string}) {
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
    return /list|follow/i.test(statusText);
  }

  return false;
}

class NNTPResponse extends Response {
  static async from(reader: Deno.Reader): Promise<Response> {
    const bufReader = new BufReader(reader);
    const responseLine: string = await bufReader.readString("\n") || "";
    // Each response MUST begin with a three-digit status indicator.
    const { groups } = responseLine.match(RESPONSE_REGEX) || {};

    return new NNTPResponse(bufReader, groups as ResponseInit);
  }

  constructor(reader: Deno.Reader, init: ResponseInit = {}) {
    const bufReader = new BufReader(reader);
    const status = Number(init.status || "");
    const statusText = init.statusText || "";

    let body = null;
    if (hasBody({ status, statusText })) {
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
          else if (line[0] === TERMINATION) {
            controller.enqueue(line.subarray(1));
          }
          else {
            controller.enqueue(line);
          }
        }
      });
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
